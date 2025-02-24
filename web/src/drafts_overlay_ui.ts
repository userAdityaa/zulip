import $ from "jquery";
import _ from "lodash";
import assert from "minimalistic-assert";

import render_draft_table_body from "../templates/draft_table_body.hbs";

import * as browser_history from "./browser_history.ts";
import * as compose_actions from "./compose_actions.ts";
import type {FormattedDraft, LocalStorageDraft} from "./drafts.ts";
import * as drafts from "./drafts.ts";
import {$t} from "./i18n.ts";
import * as message_view from "./message_view.ts";
import * as messages_overlay_ui from "./messages_overlay_ui.ts";
import * as overlays from "./overlays.ts";
import * as people from "./people.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as user_card_popover from "./user_card_popover.ts";
import * as user_group_popover from "./user_group_popover.ts";
import * as components from "./components.ts";
import type { Message } from "./message_store.ts";
import { z } from "zod";
import { abort_message, resend_message } from "./echo.ts";

function restore_draft(draft_id: string): void {
    const draft = drafts.draft_model.getDraft(draft_id);
    if (!draft) {
        return;
    }

    const compose_args = {...drafts.restore_message(draft), draft_id};

    if (compose_args.type === "stream") {
        if (compose_args.stream_id !== undefined && compose_args.topic !== "") {
            message_view.show(
                [
                    {
                        operator: "channel",
                        operand: compose_args.stream_id.toString(),
                    },
                    {operator: "topic", operand: compose_args.topic},
                ],
                {trigger: "restore draft"},
            );
        }
    } else {
        if (compose_args.private_message_recipient !== "") {
            message_view.show([{operator: "dm", operand: compose_args.private_message_recipient}], {
                trigger: "restore draft",
            });
        }
    }

    overlays.close_overlay("drafts");
    compose_actions.start({
        ...compose_args,
        message_type: compose_args.type,
    });
}

function remove_draft($draft_row: JQuery): void {
    // Deletes the draft and removes it from the list
    const draft_id = $draft_row.attr("data-draft-id")!;

    drafts.draft_model.deleteDraft(draft_id);

    $draft_row.remove();

    if ($("#drafts_table .overlay-message-row").length === 0) {
        $("#drafts_table .no-drafts").show();
    }
    if($(".outbox-messsage-row").length === 0) { 
        $('.no-outbox-message').show();
    }
    update_rendered_drafts(
        $("#drafts-from-conversation .overlay-message-row").length > 0,
        $("#other-drafts .overlay-message-row").length > 0,
    );
}

function update_rendered_drafts(
    has_drafts_from_conversation: boolean,
    has_other_drafts: boolean,
): void {
    if (has_drafts_from_conversation) {
        $("#drafts-from-conversation").show();
    } else {
        // Since there are no relevant drafts from this conversation left, switch to the "all drafts" view and remove headers.
        $("#drafts-from-conversation").hide();
        $("#other-drafts-header").hide();
    }

    if (!has_other_drafts) {
        $("#other-drafts").hide();
    }
}

const keyboard_handling_context: messages_overlay_ui.Context = {
    get_items_ids() {
        const draft_arrow = drafts.draft_model.get();
        return Object.getOwnPropertyNames(draft_arrow);
    },
    on_enter() {
        // This handles when pressing Enter while looking at drafts.
        // It restores draft that is focused.
        const draft_id_arrow = this.get_items_ids();
        const focused_draft_id = messages_overlay_ui.get_focused_element_id(this);
        if (focused_draft_id !== undefined) {
            restore_draft(focused_draft_id);
        } else {
            const first_draft = draft_id_arrow.at(-1);
            assert(first_draft !== undefined);
            restore_draft(first_draft);
        }
    },
    on_delete() {
        // Allows user to delete drafts with Backspace
        const focused_element_id = messages_overlay_ui.get_focused_element_id(this);
        if (focused_element_id === undefined) {
            return;
        }
        const $focused_row = messages_overlay_ui.row_with_focus(this);
        messages_overlay_ui.focus_on_sibling_element(this);
        remove_draft($focused_row);
    },
    items_container_selector: "drafts-container",
    items_list_selector: "drafts-list",
    row_item_selector: "draft-message-row",
    box_item_selector: "draft-message-info-box",
    id_attribute_name: "data-draft-id",
};

export function handle_keyboard_events(event_key: string): void {
    messages_overlay_ui.modals_handle_events(event_key, keyboard_handling_context);
}

export function launch(): void {
    function format_drafts(data: Record<string, LocalStorageDraft>): FormattedDraft[] {
        const unsorted_raw_drafts = Object.entries(data).map(([id, draft]) => ({...draft, id}));

        const sorted_raw_drafts = unsorted_raw_drafts.sort(
            (draft_a, draft_b) => draft_b.updatedAt - draft_a.updatedAt,
        );

        const sorted_formatted_drafts = sorted_raw_drafts
            .map((draft_row) => drafts.format_draft(draft_row))
            .filter((formatted_draft) => formatted_draft !== undefined);

        return sorted_formatted_drafts;
    }

    function get_header_for_narrow_drafts(): string {
        const {stream_name, topic, private_recipients} = drafts.current_recipient_data();
        if (private_recipients) {
            return $t(
                {defaultMessage: "Drafts from conversation with {recipient}"},
                {
                    recipient: people.emails_to_full_names_string(private_recipients.split(",")),
                },
            );
        }
        const recipient = topic ? `#${stream_name} > ${topic}` : `#${stream_name}`;
        return $t({defaultMessage: "Drafts from {recipient}"}, {recipient});
    }

    function render_widgets(narrow_drafts: FormattedDraft[], other_drafts: FormattedDraft[], outbox_message: FormattedDraft[]): void {
        $("#drafts_table").empty();

        const narrow_drafts_header = get_header_for_narrow_drafts();
        
        const rendered = render_draft_table_body({
            narrow_drafts_header,
            narrow_drafts,
            other_drafts,
            outbox_message
        });
        const $drafts_table = $("#drafts_table");
        $drafts_table.append($(rendered));
        if ($("#drafts_table .overlay-message-row").length > 0) {
            $("#drafts_table .no-drafts").hide();
            // Update possible dynamic elements.
            const $rendered_drafts = $drafts_table.find(
                ".message_content.rendered_markdown.restore-overlay-message",
            );
            $rendered_drafts.each(function () {
                rendered_markdown.update_elements($(this));
            });
        }
        if($(".outbox-message-row").length > 0) { 
            $('.no-outbox-message').hide();
        }
        update_rendered_drafts(narrow_drafts.length > 0, other_drafts.length > 0);
        update_bulk_delete_ui();
    }

    function setup_event_handlers(): void {
        $("#drafts_table .restore-overlay-message").on("click", function (e) {
            if (document.getSelection()?.type === "Range") {
                return;
            }

            e.stopPropagation();

            const $draft_row = $(this).closest(".overlay-message-row");
            const draft_id = $draft_row.attr("data-draft-id")!;
            restore_draft(draft_id);
        });

        $(".refresh-failed-message").on("click", (e) => {
            e.preventDefault();
    
            const $draftRow = $(e.target).closest(".outbox-message-row");
            const draft_id = $draftRow.attr("data-draft-id");
    
            if (!draft_id) {
                return;
            }

            const draft = drafts.draft_model.getDraft(draft_id);

            if(!draft) {
                return;
            }
            
            resend_message(draft.message!, $draftRow, {send_message, on_send_message_success});
        });

        $(".remove-failed-message").on("click", (e) => {
            e.preventDefault();
        
            const $draftRow = $(e.target).closest(".outbox-message-row");
            const draft_id = $draftRow.attr("data-draft-id");
            const draft = drafts.draft_model.getDraft(draft_id!); 

            if(!draft) { 
                return;
            }

            const message = draft.message; 
        
            if (draft_id) {
                drafts.draft_model.deleteDraft(draft_id); 
                $draftRow.remove(); 
            }

            abort_message(message!);
        });        

        const toggler = components.toggle({
            child_wants_focus: true,
            values: [
                { label: $t({ defaultMessage: "Drafts" }), key: "drafts" },
                { label: $t({ defaultMessage: "Outbox" }), key: "outbox" },
            ],
            callback(_name, key) {
                // Hide all tab content
                $(".tab-content").removeClass("active");
        
                // Show the selected "drafts" or "outbox" content
                $(`[data-tab-content="${key}"]`).addClass("active");
        
                // Show/hide notes based on the selected tab
                if (key === "drafts") {
                    $(".drafts-note").show();
                    $(".outbox-note").hide();
                } else if (key === "outbox") {
                    $(".drafts-note").hide();
                    $(".outbox-note").show();
                }
        
                // Check if there are drafts or outbox messages
                const has_drafts = $("#drafts-tab .overlay-message-row").length > 0;
                const has_outbox = $("#outbox-tab .overlay-message-row").length > 0;

                if (key === "drafts") {
                    if (has_drafts) {
                        $(".select-drafts-button").show();
                        $(".select-outbox-button").hide();
                        $(".delete-selected-drafts-button-container").show();
                        $(".delete-selected-outbox-button-container").hide();
                        $(".delete-drafts-group").show(); 
                    } else {
                        $(".delete-drafts-group").hide();
                    }
                } else if (key === "outbox") {
                    if (has_outbox) {
                        $(".select-outbox-button").show();
                        $(".select-drafts-button").hide();
                        $(".delete-selected-outbox-button-container").show();
                        $(".delete-selected-drafts-button-container").hide();
                        $(".delete-drafts-group").show(); 
                    } else {
                        $(".delete-drafts-group").hide();
                    }
                }
            },
        });
    
        toggler.get().appendTo("#draft_overlay .tab-container");
        toggler.goto("drafts");

        $("#drafts_table .restore-overlay-message").on(
            "click",
            ".user-mention",
            user_card_popover.unsaved_message_user_mention_event_handler,
        );

        $("#drafts_table .restore-overlay-message").on(
            "click",
            ".user-group-mention",
            function (this: HTMLElement, e) {
                user_group_popover.toggle_user_group_info_popover(this, undefined);
                e.stopPropagation();
            },
        );

        $("#drafts_table .overlay_message_controls .delete-overlay-message").on(
            "click",
            function () {
                const $draft_row = $(this).closest(".overlay-message-row");

                remove_draft($draft_row);
                update_bulk_delete_ui();
            },
        );

        $("#drafts_table .overlay_message_controls .draft-selection-checkbox").on("click", (e) => {
            const is_checked = is_checkbox_icon_checked($(e.target));
            toggle_checkbox_icon_state($(e.target), !is_checked);
            update_bulk_delete_ui();
        });

        $("#drafts_table .overlay_message_controls .outbox-selection-checkbox").on("click", (e) => {
            const is_checked = is_checkbox_icon_checked($(e.target));
            toggle_checkbox_icon_state($(e.target), !is_checked);
            update_bulk_delete_ui();
        });

        // Click handler for the "Select all drafts" button
        $(".select-drafts-button").on("click", (e) => {
            e.preventDefault();

            // Get all checkboxes in the drafts tab
            const $drafts_checkboxes = $(`[data-tab-content="drafts"] .draft-selection-checkbox`);

            // Check if there are any unchecked checkboxes
            const $unchecked_checkboxes = $drafts_checkboxes.filter(function () {
                return !is_checkbox_icon_checked($(this));
            });
            const check_boxes = $unchecked_checkboxes.length > 0;

            // Toggle the state of all checkboxes in the drafts tab
            $drafts_checkboxes.each(function () {
                toggle_checkbox_icon_state($(this), check_boxes);
            });

            // Update the "Select all drafts" button's state
            toggle_checkbox_icon_state($(".select-drafts-button .select-state-indicator"), check_boxes, "drafts");

            // Update the bulk delete UI
            update_bulk_delete_ui();
        });

        // Click handler for the "Select all outbox" button
        $(".select-outbox-button").on("click", (e) => {
            e.preventDefault();

            // Get all checkboxes in the outbox tab
            const $outbox_checkboxes = $(`[data-tab-content="outbox"] .outbox-selection-checkbox`);

            // Check if there are any unchecked checkboxes
            const $unchecked_checkboxes = $outbox_checkboxes.filter(function () {
                return !is_checkbox_icon_checked($(this));
            });
            const check_boxes = $unchecked_checkboxes.length > 0;

            // Toggle the state of all checkboxes in the outbox tab
            $outbox_checkboxes.each(function () {
                toggle_checkbox_icon_state($(this), check_boxes);
            });

            // Update the "Select all outbox" button's state
            toggle_checkbox_icon_state($(".select-outbox-button .select-state-indicator"), check_boxes, "outbox");

            // Update the bulk delete UI
            update_bulk_delete_ui();
        });

        $(".delete-selected-drafts-button").on("click", () => {
            $(`[data-tab-content="drafts"] .draft-selection-checkbox.fa-check-square`)
                .closest(".overlay-message-row")
                .each(function () {
                    remove_draft($(this));
                });
            update_bulk_delete_ui();
        });

        $(".delete-selected-outbox-button").on("click", () => {
            $(`[data-tab-content="outbox"] .outbox-selection-checkbox.fa-check-square`)
            .closest(".overlay-message-row")
            .each(function () {
                remove_draft($(this));
            });
            update_bulk_delete_ui();
        });
    }

    const all_drafts = drafts.draft_model.get();

    const outbox_message = Object.fromEntries(
        Object.entries(all_drafts).filter(([_, draft]) => draft.is_sending_saving)
    );

    const drafts_message = Object.fromEntries(
        Object.entries(all_drafts).filter(([_, draft]) => !draft.is_sending_saving)
    );

    const narrow_drafts = drafts.filter_drafts_by_compose_box_and_recipient(drafts_message);
    const other_drafts = _.pick(
        drafts_message,
        _.difference(Object.keys(drafts_message), Object.keys(narrow_drafts)),
    );
    const formatted_narrow_drafts = format_drafts(narrow_drafts);
    const formatted_other_drafts = format_drafts(other_drafts);
    const formatted_outbox_message = format_drafts(outbox_message);

    render_widgets(formatted_narrow_drafts, formatted_other_drafts, formatted_outbox_message);

    // We need to force a style calculation on the newly created
    // element in order for the CSS transition to take effect.
    $("#draft_overlay").css("opacity");

    open_overlay();
    const first_element_id = [...formatted_narrow_drafts, ...formatted_other_drafts][0]?.draft_id;
    messages_overlay_ui.set_initial_element(first_element_id, keyboard_handling_context);
    setup_event_handlers();
}

export function update_bulk_delete_ui(): void {
    const $unchecked_draft_checkboxes = $(".draft-selection-checkbox").filter(function () {
        return !is_checkbox_icon_checked($(this));
    });
    const $checked_draft_checkboxes = $(".draft-selection-checkbox").filter(function () {
        return is_checkbox_icon_checked($(this));
    });
    const $unchecked_outbox_checkboxes = $(".outbox-selection-checkbox").filter(function () {
        return !is_checkbox_icon_checked($(this));
    });
    const $checked_outbox_checkboxes = $(".outbox-selection-checkbox").filter(function () {
        return is_checkbox_icon_checked($(this));
    });

    const $select_drafts_button = $(".select-drafts-button");
    const $drafts_state_indicator = $(".select-drafts-button .select-state-indicator");
    const $delete_selected_drafts_button = $(".delete-selected-drafts-button");

    const $select_outbox_button = $(".select-outbox-button");
    const $outbox_state_indicator = $(".select-outbox-button .select-state-indicator");
    const $delete_selected_outbox_button = $(".delete-selected-outbox-button");

    // Update UI for drafts tab
    if ($checked_draft_checkboxes.length > 0) {
        $delete_selected_drafts_button.prop("disabled", false);
        if ($unchecked_draft_checkboxes.length === 0) {
            toggle_checkbox_icon_state($drafts_state_indicator, true, "drafts");
        } else {
            toggle_checkbox_icon_state($drafts_state_indicator, false, "drafts");
        }
    } else {
        if ($unchecked_draft_checkboxes.length > 0) {
            toggle_checkbox_icon_state($drafts_state_indicator, false, "drafts");
            $delete_selected_drafts_button.prop("disabled", true);
        } else {
            $select_drafts_button.hide();
            $delete_selected_drafts_button.hide();
        }
    }

    // Update UI for outbox tab
    if ($checked_outbox_checkboxes.length > 0) {
        $delete_selected_outbox_button.prop("disabled", false);
        if ($unchecked_outbox_checkboxes.length === 0) {
            toggle_checkbox_icon_state($outbox_state_indicator, true, "outbox");
        } else {
            toggle_checkbox_icon_state($outbox_state_indicator, false, "outbox");
        }
    } else {
        if ($unchecked_outbox_checkboxes.length > 0) {
            toggle_checkbox_icon_state($outbox_state_indicator, false, "outbox");
            $delete_selected_outbox_button.prop("disabled", true);
        } else {
            $select_outbox_button.hide();
            $delete_selected_outbox_button.hide();
        }
    }
}

export function open_overlay(): void {
    drafts.sync_count();
    overlays.open_overlay({
        name: "drafts",
        $overlay: $("#draft_overlay"),
        on_close() {
            browser_history.exit_overlay();
            drafts.sync_count();
        },
    });
}

export function is_checkbox_icon_checked($checkbox: JQuery): boolean {
    return $checkbox.hasClass("fa-check-square");
}

export function toggle_checkbox_icon_state($checkbox: JQuery, checked: boolean, tab?: string): void {
    const $parent = $checkbox.parent();
    $parent.attr("aria-checked", checked.toString());

    if (tab) {
        const buttonClass = tab.toLowerCase() === 'drafts' ? 'select-drafts-button' : 'select-outbox-button';
        $(`.${buttonClass}`).attr("aria-checked", checked.toString());
        $(`.${buttonClass} .select-state-indicator`)
            .toggleClass("fa-square-o", !checked)
            .toggleClass("fa-check-square", checked);
    } else {
        $checkbox.toggleClass("fa-square-o", !checked).toggleClass("fa-check-square", checked);
    }
}

const send_message_api_response_schema = z.object({
    id: z.number(),
    automatic_new_visibility_policy: z.number().optional(),
});

type PostMessageAPIData = z.output<typeof send_message_api_response_schema>;

let send_message: (
    request: Message,
    on_success: (raw_data: unknown) => void,
    error: (response: string, _server_error_code: string) => void,
) => void;

let on_send_message_success: (request: Message, data: PostMessageAPIData) => void;

export function initialize({
    on_send_message_success: on_success,
    send_message: send_message_content,
}: {
    on_send_message_success: (request: Message, data: PostMessageAPIData) => void;
    send_message: (
        request: Message,
        on_success: (raw_data: unknown) => void,
        error: (response: string, _server_error_code: string) => void,
    ) => void;
}): void {
    send_message = send_message_content;
    on_send_message_success = on_success;
    $("body").on("focus", "#drafts_table .overlay-message-info-box", function (this: HTMLElement) {
        messages_overlay_ui.activate_element(this, keyboard_handling_context);
    });
}
