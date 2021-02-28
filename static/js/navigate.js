import * as message_viewport from "./message_viewport";
import * as rows from "./rows";
import * as unread_ops from "./unread_ops";

function go_to_row(msg_id) {
    current_msg_list.select_id(msg_id, {then_scroll: true, from_scroll: true});
}

export function up() {
    message_viewport.set_last_movement_direction(-1);
    const msg_id = current_msg_list.prev();
    if (msg_id === undefined) {
        return;
    }
    go_to_row(msg_id);
}

export function down(with_centering) {
    message_viewport.set_last_movement_direction(1);

    if (current_msg_list.is_at_end()) {
        if (with_centering) {
            // At the last message, scroll to the bottom so we have
            // lots of nice whitespace for new messages coming in.
            const current_msg_table = rows.get_table(current_msg_list.table_name);
            message_viewport.scrollTop(
                current_msg_table.safeOuterHeight(true) - message_viewport.height() * 0.1,
            );
            if (current_msg_list.can_mark_messages_read()) {
                unread_ops.mark_current_list_as_read();
            }
        }

        return;
    }

    // Normal path starts here.
    const msg_id = current_msg_list.next();
    if (msg_id === undefined) {
        return;
    }
    go_to_row(msg_id);
}

export function to_home() {
    message_viewport.set_last_movement_direction(-1);
    const first_id = current_msg_list.first().id;
    current_msg_list.select_id(first_id, {then_scroll: true, from_scroll: true});
}

export function to_end() {
    const next_id = current_msg_list.last().id;
    message_viewport.set_last_movement_direction(1);
    current_msg_list.select_id(next_id, {then_scroll: true, from_scroll: true});
    if (current_msg_list.can_mark_messages_read()) {
        unread_ops.mark_current_list_as_read();
    }
}

function amount_to_paginate() {
    // Some day we might have separate versions of this function
    // for Page Up vs. Page Down, but for now it's the same
    // strategy in either direction.
    const info = message_viewport.message_viewport_info();
    const page_size = info.visible_height;

    // We don't want to page up a full page, because Zulip users
    // are especially worried about missing messages, so we want
    // a little bit of the old page to stay on the screen.  The
    // value chosen here is roughly 2 or 3 lines of text, but there
    // is nothing sacred about it, and somebody more anal than me
    // might wish to tie this to the size of some particular DOM
    // element.
    const overlap_amount = 55;

    let delta = page_size - overlap_amount;

    // If the user has shrunk their browser a whole lot, pagination
    // is not going to be very pleasant, but we can at least
    // ensure they go in the right direction.
    if (delta < 1) {
        delta = 1;
    }

    return delta;
}

export function page_up_the_right_amount() {
    // This function's job is to scroll up the right amount,
    // after the user hits Page Up.  We do this ourselves
    // because we can't rely on the browser to account for certain
    // page elements, like the compose box, that sit in fixed
    // positions above the message pane.  For other scrolling
    // related adjustments, try to make those happen in the
    // scroll handlers, not here.
    const delta = amount_to_paginate();
    message_viewport.scrollTop(message_viewport.scrollTop() - delta);
}

export function page_down_the_right_amount() {
    // see also: page_up_the_right_amount
    const delta = amount_to_paginate();
    message_viewport.scrollTop(message_viewport.scrollTop() + delta);
}

export function page_up() {
    if (message_viewport.at_top() && !current_msg_list.empty()) {
        current_msg_list.select_id(current_msg_list.first().id, {then_scroll: false});
    } else {
        page_up_the_right_amount();
    }
}

export function page_down() {
    if (message_viewport.at_bottom() && !current_msg_list.empty()) {
        current_msg_list.select_id(current_msg_list.last().id, {then_scroll: false});
        if (current_msg_list.can_mark_messages_read()) {
            unread_ops.mark_current_list_as_read();
        }
    } else {
        page_down_the_right_amount();
    }
}

export function scroll_to_selected() {
    const selected_row = current_msg_list.selected_row();
    if (selected_row && selected_row.length !== 0) {
        message_viewport.recenter_view(selected_row);
    }
}

let scroll_to_selected_planned = false;

export function plan_scroll_to_selected() {
    scroll_to_selected_planned = true;
}

export function maybe_scroll_to_selected() {
    // If we have made a plan to scroll to the selected message but
    // deferred doing so, do so here.
    if (scroll_to_selected_planned) {
        scroll_to_selected();
        scroll_to_selected_planned = false;
    }
}
