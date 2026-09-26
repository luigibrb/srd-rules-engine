"""Minimal terminal I/O with optional ANSI styling, injectable for tests."""

from __future__ import annotations

import os
import sys
from collections.abc import Callable


class QuitBuilder(Exception):
    """The user asked to leave the builder."""


class BackToMenu(Exception):
    """The user asked to abandon the current step and return to the step menu."""


_STYLES = {
    "bold": "1",
    "dim": "2",
    "red": "31",
    "green": "32",
    "yellow": "33",
    "blue": "34",
    "cyan": "36",
}


class Console:
    def __init__(
        self,
        input_fn: Callable[[str], str] = input,
        output_fn: Callable[[str], None] = print,
        color: bool | None = None,
    ):
        self._input = input_fn
        self._output = output_fn
        if color is None:
            color = sys.stdout.isatty() and "NO_COLOR" not in os.environ
        self.color = color

    def style(self, text: str, *styles: str) -> str:
        if not self.color or not styles:
            return text
        codes = ";".join(_STYLES[s] for s in styles)
        return f"\033[{codes}m{text}\033[0m"

    def say(self, text: str = "") -> None:
        self._output(text)

    def title(self, text: str) -> None:
        self.say()
        self.say(self.style(f"── {text} " + "─" * max(0, 60 - len(text)), "bold", "cyan"))

    def error(self, text: str) -> None:
        self.say(self.style(f"  ✘ {text}", "red"))

    def warn(self, text: str) -> None:
        self.say(self.style(f"  ! {text}", "yellow"))

    def info(self, text: str) -> None:
        self.say(self.style(f"  {text}", "dim"))

    def ask(self, prompt: str) -> str:
        """Read a line. ``quit`` and ``back`` work at every prompt."""
        try:
            raw = self._input(self.style(f"{prompt} ", "bold")).strip()
        except EOFError as exc:
            raise QuitBuilder from exc
        lowered = raw.lower()
        if lowered in ("q", "quit", "exit"):
            raise QuitBuilder
        if lowered in ("b", "back", "menu"):
            raise BackToMenu
        return raw

    def confirm(self, prompt: str, default: bool = True) -> bool:
        hint = "[Y/n]" if default else "[y/N]"
        while True:
            answer = self.ask(f"{prompt} {hint}").lower()
            if not answer:
                return default
            if answer in ("y", "yes"):
                return True
            if answer in ("n", "no"):
                return False
