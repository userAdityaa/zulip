from typing import Annotated, Any

import orjson
from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.db import transaction
from django.http import HttpRequest, HttpResponse, HttpResponseNotFound
from django.utils.http import content_disposition_header
from django.utils.translation import gettext as _
from django.views.decorators.csrf import csrf_exempt
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_pascal

from zerver.decorator import get_basic_credentials, validate_api_key
from zerver.lib.exceptions import AccessDeniedError, JsonableError
from zerver.lib.mime_types import guess_type
from zerver.lib.rate_limiter import is_local_addr
from zerver.lib.typed_endpoint import JsonBodyPayload, typed_endpoint
from zerver.lib.upload import (
    RealmUploadQuotaError,
    attachment_vips_source,
    check_upload_within_quota,
    create_attachment,
    sanitize_name,
    upload_backend,
)
from zerver.lib.upload.base import INLINE_MIME_TYPES
from zerver.models import Realm, UserProfile


# See https://tus.github.io/tusd/advanced-topics/hooks/ for the spec
# for these.
class TusUpload(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_pascal)
    id: Annotated[str, Field(alias="ID")]
    size: int | None
    size_is_deferred: bool
    offset: int
    meta_data: dict[str, str]
    is_partial: bool
    is_final: bool
    partial_uploads: list[str] | None
    storage: dict[str, str] | None


class TusHTTPRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_pascal)
    method: str
    uri: Annotated[str, Field(alias="URI")]
    remote_addr: str
    header: dict[str, list[str]]


class TusEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_pascal)
    upload: TusUpload
    http_request: Annotated[TusHTTPRequest, Field(alias="HTTPRequest")]


class TusHook(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_pascal)
    type: str
    event: TusEvent


# Note that we do not raise JsonableError in these views
# because our client is not a consumer of the Zulip API -- it's tusd,
# which has its own ideas of what error responses look like.
def tusd_json_response(data: dict[str, Any]) -> HttpResponse:
    return HttpResponse(
        content=orjson.dumps(data, option=orjson.OPT_APPEND_NEWLINE),
        content_type="application/json",
        status=200,
    )


def reject_upload(message: str, status_code: int) -> HttpResponse:
    # Due to https://github.com/transloadit/uppy/issues/5460, uppy
    # will retry responses with a statuscode of exactly 400, so we
    # return 4xx status codes which are more specific to trigger an
    # immediate rejection.
    return tusd_json_response(
        {
            "HttpResponse": {
                "StatusCode": status_code,
                "Body": orjson.dumps({"message": message}).decode(),
                "Header": {
                    "Content-Type": "application/json",
                },
            },
            "RejectUpload": True,
        }
    )


def handle_upload_pre_create_hook(
    request: HttpRequest, user_profile: UserProfile, data: TusUpload
) -> HttpResponse:
    if data.size_is_deferred or data.size is None:
        return reject_upload("SizeIsDeferred is not supported", 411)

    max_file_upload_size_mebibytes = user_profile.realm.get_max_file_upload_size_mebibytes()
    if data.size > max_file_upload_size_mebibytes * 1024 * 1024:
        if user_profile.realm.plan_type != Realm.PLAN_TYPE_SELF_HOSTED:
            return reject_upload(
                _(
                    "File is larger than the maximum upload size ({max_size} MiB) allowed by your organization's plan."
                ).format(
                    max_size=max_file_upload_size_mebibytes,
                ),
                413,
            )
        else:
            return reject_upload(
                _(
                    "File is larger than this server's configured maximum upload size ({max_size} MiB)."
                ).format(
                    max_size=max_file_upload_size_mebibytes,
                ),
                413,
            )

    try:
        check_upload_within_quota(user_profile.realm, data.size)
    except RealmUploadQuotaError as e:
        return reject_upload(str(e), 413)

    # Determine the path_id to store it at
    file_name = sanitize_name(data.meta_data.get("filename", ""), strict=True)
    path_id = upload_backend.generate_message_upload_path(str(user_profile.realm_id), file_name)
    return tusd_json_response({"ChangeFileInfo": {"ID": path_id}})


def handle_upload_pre_finish_hook(
    request: HttpRequest, user_profile: UserProfile, data: TusUpload
) -> HttpResponse:
    # With an S3 backend, the filename we passed in pre_create's
    # data.id has a randomly-generated "mutlipart-id" appended with a
    # `+`.  Our path_ids cannot contain `+`, so we strip any suffix
    # starting with `+`.
    path_id = data.id.partition("+")[0]

    tus_metadata = data.meta_data
    filename = tus_metadata.get("filename", "")

    # We want to store as the filename a version that clients are
    # likely to be able to accept via "Save as..."
    if filename in {"", ".", ".."}:
        filename = "uploaded-file"

    content_type = tus_metadata.get("filetype")
    if not content_type:
        content_type = guess_type(filename)[0]
        if content_type is None:
            content_type = "application/octet-stream"

    if settings.LOCAL_UPLOADS_DIR is None:
        # We "copy" the file to itself to update the Content-Type,
        # Content-Disposition, and storage class of the data.  This
        # parallels the work from upload_content_to_s3 in
        # zerver.lib.uploads.s3
        s3_metadata = {
            "user_profile_id": str(user_profile.id),
            "realm_id": str(user_profile.realm_id),
        }

        is_attachment = content_type not in INLINE_MIME_TYPES
        content_disposition = content_disposition_header(is_attachment, filename) or "inline"

        from zerver.lib.upload.s3 import S3UploadBackend

        assert isinstance(upload_backend, S3UploadBackend)
        key = upload_backend.uploads_bucket.Object(path_id)
        key.copy_from(
            ContentType=content_type,
            ContentDisposition=content_disposition,
            CopySource={"Bucket": settings.S3_AUTH_UPLOADS_BUCKET, "Key": path_id},
            Metadata=s3_metadata,
            MetadataDirective="REPLACE",
            StorageClass=settings.S3_UPLOADS_STORAGE_CLASS,
        )

        # https://tus.github.io/tusd/storage-backends/overview/#storage-format
        # tusd also creates a .info file next to the upload, which
        # must be preserved for HEAD requests (to check for upload
        # state) to work.  These files are inaccessible via Zulip, and
        # small enough to not pose any notable storage use; but we
        # should store them with the right StorageClass.
        if settings.S3_UPLOADS_STORAGE_CLASS != "STANDARD":
            info_key = upload_backend.uploads_bucket.Object(path_id + ".info")
            info_key.copy_from(
                CopySource={"Bucket": settings.S3_AUTH_UPLOADS_BUCKET, "Key": path_id + ".info"},
                MetadataDirective="COPY",
                StorageClass=settings.S3_UPLOADS_STORAGE_CLASS,
            )

    with transaction.atomic():
        create_attachment(
            filename,
            path_id,
            content_type,
            attachment_vips_source(path_id),
            user_profile,
            user_profile.realm,
        )

    path = "/user_uploads/" + path_id
    return tusd_json_response(
        {
            "HttpResponse": {
                "StatusCode": 200,
                "Body": orjson.dumps({"url": path, "filename": filename}).decode(),
                "Header": {
                    "Content-Type": "application/json",
                },
            },
        }
    )


def authenticate_user(request: HttpRequest) -> UserProfile | AnonymousUser:
    # This acts like the authenticated_rest_api_view wrapper, while
    # allowing fallback to session-based request.user
    if "Authorization" in request.headers:
        try:
            role, api_key = get_basic_credentials(request)
            return validate_api_key(
                request,
                role,
                api_key,
            )

        except JsonableError:
            pass

    # If that failed, fall back to session auth
    return request.user


@csrf_exempt
@typed_endpoint
def handle_tusd_hook(
    request: HttpRequest,
    *,
    payload: JsonBodyPayload[TusHook],
) -> HttpResponse:
    # Make sure this came from localhost
    if not is_local_addr(request.META["REMOTE_ADDR"]):
        raise AccessDeniedError

    maybe_user = authenticate_user(request)
    if isinstance(maybe_user, AnonymousUser):
        return reject_upload("Unauthenticated upload", 401)

    hook_name = payload.type
    if hook_name == "pre-create":
        return handle_upload_pre_create_hook(request, maybe_user, payload.event.upload)
    elif hook_name == "pre-finish":
        return handle_upload_pre_finish_hook(request, maybe_user, payload.event.upload)
    else:
        return HttpResponseNotFound()
