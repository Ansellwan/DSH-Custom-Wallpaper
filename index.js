/**
 * Host half of the wallpaper bundle.
 *
 * The wallpaper is a pure browser-side decoration: the Client half paints the
 * backdrop and owns the Settings page, and every preference lives in the
 * page's own storage, so this half has no Host state, no Config schema and no
 * dependency beyond the plugin context it is handed.
 *
 * @param {import('@deepseek-ai/cordis').Context} _ctx - Host plugin context.
 */
export function apply(_ctx) {}
