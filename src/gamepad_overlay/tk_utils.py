"""Reusable tkinter widget helpers."""

from __future__ import annotations

import tkinter as tk
from tkinter import font as tkfont
from tkinter import ttk


def setup_checkbutton_styles() -> None:
    """Replace clam's X indicator with alt's checkmark glyph for TCheckbutton."""
    style = ttk.Style()
    style.element_create(
        "alt.Checkbutton.indicator", "from", "alt", "Checkbutton.indicator"
    )
    style.layout(
        "TCheckbutton",
        [
            (
                "Checkbutton.padding",
                {
                    "sticky": "nswe",
                    "children": [
                        (
                            "alt.Checkbutton.indicator",
                            {"side": "left", "sticky": ""},
                        ),
                        (
                            "Checkbutton.focus",
                            {
                                "side": "left",
                                "sticky": "w",
                                "children": [
                                    ("Checkbutton.label", {"sticky": "nswe"})
                                ],
                            },
                        ),
                    ],
                },
            )
        ],
    )


class LabelGrooveFrame(tk.LabelFrame):
    """tk.LabelFrame with groove border, theme-matched background, and an
    interior frame whose bottom padding compensates for the label inset so
    content appears vertically centered."""

    def __init__(self, parent: tk.Widget, *, text: str = "") -> None:
        background = ttk.Style().lookup("TFrame", "background")
        super().__init__(
            parent,
            text=text,
            relief="groove",
            borderwidth=2,
            background=background,
        )
        inset = tkfont.nametofont("TkDefaultFont").metrics("linespace") // 2
        self.interior = ttk.Frame(self)
        self.interior.pack(fill=tk.BOTH, expand=True, pady=(0, inset))
