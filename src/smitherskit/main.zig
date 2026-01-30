// SmithersKit - A proxy layer over GhosttyKit for future AI features
//
// For now, this is a pass-through layer that re-exports all GhosttyKit
// functions with a smithers_ prefix. Later, we can intercept I/O here
// for AI features like:
// - Logging terminal I/O to SQLite
// - Intercepting special key sequences for AI commands
// - Injecting AI-generated text into the terminal
// - Capturing screen state for AI vision features

const std = @import("std");

// Import GhosttyKit via C interface
const ghostty = @cImport({
    @cInclude("ghostty.h");
});

// Re-export all types from GhosttyKit
pub const App = ghostty.ghostty_app_t;
pub const Config = ghostty.ghostty_config_t;
pub const Surface = ghostty.ghostty_surface_t;
pub const Inspector = ghostty.ghostty_inspector_t;

// ============================================================================
// Initialization
// ============================================================================

pub export fn smithers_init(argc: usize, argv: [*c][*c]u8) callconv(.c) c_int {
    return ghostty.ghostty_init(argc, argv);
}

pub export fn smithers_cli_try_action() callconv(.c) void {
    ghostty.ghostty_cli_try_action();
}

pub export fn smithers_info() callconv(.c) ghostty.ghostty_info_s {
    return ghostty.ghostty_info();
}

pub export fn smithers_translate(key: [*c]const u8) callconv(.c) [*c]const u8 {
    return ghostty.ghostty_translate(key);
}

pub export fn smithers_string_free(str: ghostty.ghostty_string_s) callconv(.c) void {
    ghostty.ghostty_string_free(str);
}

// ============================================================================
// Configuration
// ============================================================================

pub export fn smithers_config_new() callconv(.c) Config {
    return ghostty.ghostty_config_new();
}

pub export fn smithers_config_free(config: Config) callconv(.c) void {
    ghostty.ghostty_config_free(config);
}

pub export fn smithers_config_clone(config: Config) callconv(.c) Config {
    return ghostty.ghostty_config_clone(config);
}

pub export fn smithers_config_load_cli_args(config: Config) callconv(.c) void {
    ghostty.ghostty_config_load_cli_args(config);
}

pub export fn smithers_config_load_file(config: Config, path: [*c]const u8) callconv(.c) void {
    ghostty.ghostty_config_load_file(config, path);
}

pub export fn smithers_config_load_default_files(config: Config) callconv(.c) void {
    ghostty.ghostty_config_load_default_files(config);
}

pub export fn smithers_config_load_recursive_files(config: Config) callconv(.c) void {
    ghostty.ghostty_config_load_recursive_files(config);
}

pub export fn smithers_config_finalize(config: Config) callconv(.c) void {
    ghostty.ghostty_config_finalize(config);
}

pub export fn smithers_config_get(
    config: Config,
    out: ?*anyopaque,
    key: [*c]const u8,
    key_len: usize,
) callconv(.c) bool {
    return ghostty.ghostty_config_get(config, out, key, key_len);
}

pub export fn smithers_config_trigger(
    config: Config,
    action: [*c]const u8,
    action_len: usize,
) callconv(.c) ghostty.ghostty_input_trigger_s {
    return ghostty.ghostty_config_trigger(config, action, action_len);
}

pub export fn smithers_config_diagnostics_count(config: Config) callconv(.c) u32 {
    return ghostty.ghostty_config_diagnostics_count(config);
}

pub export fn smithers_config_get_diagnostic(config: Config, idx: u32) callconv(.c) ghostty.ghostty_diagnostic_s {
    return ghostty.ghostty_config_get_diagnostic(config, idx);
}

pub export fn smithers_config_open_path() callconv(.c) ghostty.ghostty_string_s {
    return ghostty.ghostty_config_open_path();
}

// ============================================================================
// Application
// ============================================================================

pub export fn smithers_app_new(
    runtime_config: [*c]const ghostty.ghostty_runtime_config_s,
    config: Config,
) callconv(.c) App {
    return ghostty.ghostty_app_new(runtime_config, config);
}

pub export fn smithers_app_free(app: App) callconv(.c) void {
    ghostty.ghostty_app_free(app);
}

pub export fn smithers_app_tick(app: App) callconv(.c) void {
    ghostty.ghostty_app_tick(app);
}

pub export fn smithers_app_userdata(app: App) callconv(.c) ?*anyopaque {
    return ghostty.ghostty_app_userdata(app);
}

pub export fn smithers_app_set_focus(app: App, focused: bool) callconv(.c) void {
    ghostty.ghostty_app_set_focus(app, focused);
}

pub export fn smithers_app_key(app: App, key: ghostty.ghostty_input_key_s) callconv(.c) bool {
    return ghostty.ghostty_app_key(app, key);
}

pub export fn smithers_app_key_is_binding(app: App, key: ghostty.ghostty_input_key_s) callconv(.c) bool {
    return ghostty.ghostty_app_key_is_binding(app, key);
}

pub export fn smithers_app_keyboard_changed(app: App) callconv(.c) void {
    ghostty.ghostty_app_keyboard_changed(app);
}

pub export fn smithers_app_open_config(app: App) callconv(.c) void {
    ghostty.ghostty_app_open_config(app);
}

pub export fn smithers_app_update_config(app: App, config: Config) callconv(.c) void {
    ghostty.ghostty_app_update_config(app, config);
}

pub export fn smithers_app_needs_confirm_quit(app: App) callconv(.c) bool {
    return ghostty.ghostty_app_needs_confirm_quit(app);
}

pub export fn smithers_app_has_global_keybinds(app: App) callconv(.c) bool {
    return ghostty.ghostty_app_has_global_keybinds(app);
}

pub export fn smithers_app_set_color_scheme(app: App, scheme: ghostty.ghostty_color_scheme_e) callconv(.c) void {
    ghostty.ghostty_app_set_color_scheme(app, scheme);
}

// ============================================================================
// Surface Configuration
// ============================================================================

pub export fn smithers_surface_config_new() callconv(.c) ghostty.ghostty_surface_config_s {
    return ghostty.ghostty_surface_config_new();
}

// ============================================================================
// Surface
// ============================================================================

pub export fn smithers_surface_new(
    app: App,
    config: [*c]const ghostty.ghostty_surface_config_s,
) callconv(.c) Surface {
    return ghostty.ghostty_surface_new(app, config);
}

pub export fn smithers_surface_free(surface: Surface) callconv(.c) void {
    ghostty.ghostty_surface_free(surface);
}

pub export fn smithers_surface_userdata(surface: Surface) callconv(.c) ?*anyopaque {
    return ghostty.ghostty_surface_userdata(surface);
}

pub export fn smithers_surface_app(surface: Surface) callconv(.c) App {
    return ghostty.ghostty_surface_app(surface);
}

pub export fn smithers_surface_inherited_config(
    surface: Surface,
    context: ghostty.ghostty_surface_context_e,
) callconv(.c) ghostty.ghostty_surface_config_s {
    return ghostty.ghostty_surface_inherited_config(surface, context);
}

pub export fn smithers_surface_update_config(surface: Surface, config: Config) callconv(.c) void {
    ghostty.ghostty_surface_update_config(surface, config);
}

pub export fn smithers_surface_needs_confirm_quit(surface: Surface) callconv(.c) bool {
    return ghostty.ghostty_surface_needs_confirm_quit(surface);
}

pub export fn smithers_surface_process_exited(surface: Surface) callconv(.c) bool {
    return ghostty.ghostty_surface_process_exited(surface);
}

pub export fn smithers_surface_refresh(surface: Surface) callconv(.c) void {
    ghostty.ghostty_surface_refresh(surface);
}

pub export fn smithers_surface_draw(surface: Surface) callconv(.c) void {
    ghostty.ghostty_surface_draw(surface);
}

pub export fn smithers_surface_set_content_scale(surface: Surface, x: f64, y: f64) callconv(.c) void {
    ghostty.ghostty_surface_set_content_scale(surface, x, y);
}

pub export fn smithers_surface_set_focus(surface: Surface, focused: bool) callconv(.c) void {
    ghostty.ghostty_surface_set_focus(surface, focused);
}

pub export fn smithers_surface_set_occlusion(surface: Surface, occluded: bool) callconv(.c) void {
    ghostty.ghostty_surface_set_occlusion(surface, occluded);
}

pub export fn smithers_surface_set_size(surface: Surface, width: u32, height: u32) callconv(.c) void {
    ghostty.ghostty_surface_set_size(surface, width, height);
}

pub export fn smithers_surface_size(surface: Surface) callconv(.c) ghostty.ghostty_surface_size_s {
    return ghostty.ghostty_surface_size(surface);
}

pub export fn smithers_surface_set_color_scheme(
    surface: Surface,
    scheme: ghostty.ghostty_color_scheme_e,
) callconv(.c) void {
    ghostty.ghostty_surface_set_color_scheme(surface, scheme);
}

pub export fn smithers_surface_key_translation_mods(
    surface: Surface,
    mods: ghostty.ghostty_input_mods_e,
) callconv(.c) ghostty.ghostty_input_mods_e {
    return ghostty.ghostty_surface_key_translation_mods(surface, mods);
}

pub export fn smithers_surface_key(surface: Surface, key: ghostty.ghostty_input_key_s) callconv(.c) bool {
    return ghostty.ghostty_surface_key(surface, key);
}

pub export fn smithers_surface_key_is_binding(
    surface: Surface,
    key: ghostty.ghostty_input_key_s,
    flags: [*c]ghostty.ghostty_binding_flags_e,
) callconv(.c) bool {
    return ghostty.ghostty_surface_key_is_binding(surface, key, flags);
}

pub export fn smithers_surface_text(surface: Surface, text: [*c]const u8, len: usize) callconv(.c) void {
    ghostty.ghostty_surface_text(surface, text, len);
}

pub export fn smithers_surface_preedit(surface: Surface, text: [*c]const u8, len: usize) callconv(.c) void {
    ghostty.ghostty_surface_preedit(surface, text, len);
}

pub export fn smithers_surface_mouse_captured(surface: Surface) callconv(.c) bool {
    return ghostty.ghostty_surface_mouse_captured(surface);
}

pub export fn smithers_surface_mouse_button(
    surface: Surface,
    state: ghostty.ghostty_input_mouse_state_e,
    button: ghostty.ghostty_input_mouse_button_e,
    mods: ghostty.ghostty_input_mods_e,
) callconv(.c) bool {
    return ghostty.ghostty_surface_mouse_button(surface, state, button, mods);
}

pub export fn smithers_surface_mouse_pos(
    surface: Surface,
    x: f64,
    y: f64,
    mods: ghostty.ghostty_input_mods_e,
) callconv(.c) void {
    ghostty.ghostty_surface_mouse_pos(surface, x, y, mods);
}

pub export fn smithers_surface_mouse_scroll(
    surface: Surface,
    x: f64,
    y: f64,
    mods: ghostty.ghostty_input_scroll_mods_t,
) callconv(.c) void {
    ghostty.ghostty_surface_mouse_scroll(surface, x, y, mods);
}

pub export fn smithers_surface_mouse_pressure(surface: Surface, stage: u32, pressure: f64) callconv(.c) void {
    ghostty.ghostty_surface_mouse_pressure(surface, stage, pressure);
}

pub export fn smithers_surface_ime_point(
    surface: Surface,
    x: *f64,
    y: *f64,
    w: *f64,
    h: *f64,
) callconv(.c) void {
    ghostty.ghostty_surface_ime_point(surface, x, y, w, h);
}

pub export fn smithers_surface_request_close(surface: Surface) callconv(.c) void {
    ghostty.ghostty_surface_request_close(surface);
}

pub export fn smithers_surface_split(
    surface: Surface,
    direction: ghostty.ghostty_action_split_direction_e,
) callconv(.c) void {
    ghostty.ghostty_surface_split(surface, direction);
}

pub export fn smithers_surface_split_focus(
    surface: Surface,
    direction: ghostty.ghostty_action_goto_split_e,
) callconv(.c) void {
    ghostty.ghostty_surface_split_focus(surface, direction);
}

pub export fn smithers_surface_split_resize(
    surface: Surface,
    direction: ghostty.ghostty_action_resize_split_direction_e,
    amount: u16,
) callconv(.c) void {
    ghostty.ghostty_surface_split_resize(surface, direction, amount);
}

pub export fn smithers_surface_split_equalize(surface: Surface) callconv(.c) void {
    ghostty.ghostty_surface_split_equalize(surface);
}

pub export fn smithers_surface_binding_action(
    surface: Surface,
    action: [*c]const u8,
    len: usize,
) callconv(.c) bool {
    return ghostty.ghostty_surface_binding_action(surface, action, len);
}

pub export fn smithers_surface_complete_clipboard_request(
    surface: Surface,
    data: [*c]const u8,
    state: ?*anyopaque,
    confirmed: bool,
) callconv(.c) void {
    ghostty.ghostty_surface_complete_clipboard_request(surface, data, state, confirmed);
}

pub export fn smithers_surface_has_selection(surface: Surface) callconv(.c) bool {
    return ghostty.ghostty_surface_has_selection(surface);
}

pub export fn smithers_surface_read_selection(
    surface: Surface,
    text: *ghostty.ghostty_text_s,
) callconv(.c) bool {
    return ghostty.ghostty_surface_read_selection(surface, text);
}

pub export fn smithers_surface_read_text(
    surface: Surface,
    selection: ghostty.ghostty_selection_s,
    text: *ghostty.ghostty_text_s,
) callconv(.c) bool {
    return ghostty.ghostty_surface_read_text(surface, selection, text);
}

pub export fn smithers_surface_free_text(surface: Surface, text: *ghostty.ghostty_text_s) callconv(.c) void {
    ghostty.ghostty_surface_free_text(surface, text);
}

// ============================================================================
// macOS-specific Surface APIs
// ============================================================================

pub export fn smithers_surface_set_display_id(surface: Surface, display_id: u32) callconv(.c) void {
    ghostty.ghostty_surface_set_display_id(surface, display_id);
}

pub export fn smithers_surface_quicklook_font(surface: Surface) callconv(.c) ?*anyopaque {
    return ghostty.ghostty_surface_quicklook_font(surface);
}

pub export fn smithers_surface_quicklook_word(
    surface: Surface,
    text: *ghostty.ghostty_text_s,
) callconv(.c) bool {
    return ghostty.ghostty_surface_quicklook_word(surface, text);
}

// ============================================================================
// Inspector
// ============================================================================

pub export fn smithers_surface_inspector(surface: Surface) callconv(.c) Inspector {
    return ghostty.ghostty_surface_inspector(surface);
}

pub export fn smithers_inspector_free(surface: Surface) callconv(.c) void {
    ghostty.ghostty_inspector_free(surface);
}

pub export fn smithers_inspector_set_focus(inspector: Inspector, focused: bool) callconv(.c) void {
    ghostty.ghostty_inspector_set_focus(inspector, focused);
}

pub export fn smithers_inspector_set_content_scale(inspector: Inspector, x: f64, y: f64) callconv(.c) void {
    ghostty.ghostty_inspector_set_content_scale(inspector, x, y);
}

pub export fn smithers_inspector_set_size(inspector: Inspector, width: u32, height: u32) callconv(.c) void {
    ghostty.ghostty_inspector_set_size(inspector, width, height);
}

pub export fn smithers_inspector_mouse_button(
    inspector: Inspector,
    state: ghostty.ghostty_input_mouse_state_e,
    button: ghostty.ghostty_input_mouse_button_e,
    mods: ghostty.ghostty_input_mods_e,
) callconv(.c) void {
    ghostty.ghostty_inspector_mouse_button(inspector, state, button, mods);
}

pub export fn smithers_inspector_mouse_pos(inspector: Inspector, x: f64, y: f64) callconv(.c) void {
    ghostty.ghostty_inspector_mouse_pos(inspector, x, y);
}

pub export fn smithers_inspector_mouse_scroll(
    inspector: Inspector,
    x: f64,
    y: f64,
    mods: ghostty.ghostty_input_scroll_mods_t,
) callconv(.c) void {
    ghostty.ghostty_inspector_mouse_scroll(inspector, x, y, mods);
}

pub export fn smithers_inspector_key(
    inspector: Inspector,
    action: ghostty.ghostty_input_action_e,
    key: ghostty.ghostty_input_key_e,
    mods: ghostty.ghostty_input_mods_e,
) callconv(.c) void {
    ghostty.ghostty_inspector_key(inspector, action, key, mods);
}

pub export fn smithers_inspector_text(inspector: Inspector, text: [*c]const u8) callconv(.c) void {
    ghostty.ghostty_inspector_text(inspector, text);
}

// ============================================================================
// macOS-specific Inspector APIs (Metal rendering)
// ============================================================================

pub export fn smithers_inspector_metal_init(inspector: Inspector, device: ?*anyopaque) callconv(.c) bool {
    return ghostty.ghostty_inspector_metal_init(inspector, device);
}

pub export fn smithers_inspector_metal_render(
    inspector: Inspector,
    command_buffer: ?*anyopaque,
    drawable: ?*anyopaque,
) callconv(.c) void {
    ghostty.ghostty_inspector_metal_render(inspector, command_buffer, drawable);
}

pub export fn smithers_inspector_metal_shutdown(inspector: Inspector) callconv(.c) bool {
    return ghostty.ghostty_inspector_metal_shutdown(inspector);
}

// ============================================================================
// Misc APIs
// ============================================================================

pub export fn smithers_set_window_background_blur(app: App, window: ?*anyopaque) callconv(.c) void {
    ghostty.ghostty_set_window_background_blur(app, window);
}

pub export fn smithers_benchmark_cli(cmd: [*c]const u8, args: [*c]const u8) callconv(.c) bool {
    return ghostty.ghostty_benchmark_cli(cmd, args);
}

// ============================================================================
// Version Information
// ============================================================================

pub export fn smithers_version() callconv(.c) [*:0]const u8 {
    return "0.1.0";
}
