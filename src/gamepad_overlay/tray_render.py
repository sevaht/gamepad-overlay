"""Renders the gamepad face-button icon for the tray and the window title bar.

The A/B/X/Y face-button graphic is drawn with PIL (supersampled) and used for
both the tray icon (at the host's size) and the window title-bar icon (via
``TkApp.set_window_icon``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PIL import Image, ImageDraw

if TYPE_CHECKING:
    from collections.abc import Callable

# Button geometry, defined in a 64x64 design space.
ICON_BUTTON_SIZE = 24
ICON_BUTTON_STROKE_WIDTH = 3
ICON_BUTTON_CENTERS = {
    "Y": (32.0, 14.0),
    "B": (50.0, 32.0),
    "A": (32.0, 50.0),
    "X": (14.0, 32.0),
}
XBOX_FACE_BUTTON_PRESSED_COLORS = {
    "Y": (255, 255, 51),
    "B": (255, 51, 51),
    "A": (63, 207, 63),
    "X": (51, 119, 255),
}
XBOX_FACE_BUTTON_RELEASED_COLORS = {
    "Y": (95, 95, 31),
    "B": (95, 31, 31),
    "A": (31, 79, 32),
    "X": (31, 31, 95),
}


def _create_face_buttons_image(
    *, connected: bool, size: int = 64
) -> Image.Image:
    # The geometry constants are defined in a 64x64 space. PIL's ellipse is not
    # anti-aliased, so a direct small render turns circles into jagged diamonds.
    # Draw supersampled and downscale with BOX (area averaging) for smooth,
    # round buttons. This anti-aliasing inevitably leaves a faint blended pixel
    # or two where the border meets the fill -- the same thing the window icon
    # shows once the WM downscales it -- which is the price of round (vs.
    # crisp-but-diamond) buttons at this size.
    supersample = 4
    render_size = size * supersample
    image = Image.new("RGBA", (render_size, render_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    colors = (
        XBOX_FACE_BUTTON_PRESSED_COLORS
        if connected
        else XBOX_FACE_BUTTON_RELEASED_COLORS
    )
    scale = render_size / 64
    radius = (ICON_BUTTON_SIZE / 2) * scale
    # Border width in *target* pixels (>=1), scaled up for the supersample, so
    # it downscales to an exact integer-pixel line that stays uniformly solid
    # rather than a sub-pixel width that blends into the fill on the diagonals.
    target_stroke = max(1, round(ICON_BUTTON_STROKE_WIDTH * size / 64))
    stroke = target_stroke * supersample
    for button_name, (center_x, center_y) in ICON_BUTTON_CENTERS.items():
        cx = center_x * scale
        cy = center_y * scale
        draw.ellipse(
            (cx - radius, cy - radius, cx + radius, cy + radius),
            fill=colors[button_name],
            outline="black",
            width=stroke,
        )
    if supersample != 1:
        image = image.resize((size, size), Image.Resampling.BOX)
    return image


def _tray_icon_renderer(connected: bool) -> Callable[[int], Image.Image]:
    """Return a callable that renders the tray icon natively at a given size."""

    def render(size: int) -> Image.Image:
        return _create_face_buttons_image(connected=connected, size=size)

    return render
