"""Builds a Claude Code theme file from a palette of 13 colors.

usage:
  build_theme.py PALETTE.json --out DIR            write DIR/SLUG.json; SLUG is the palette's file name
  build_theme.py --check PALETTES_DIR THEMES_DIR   fail unless every palette's theme file is current

A palette names the theme, its base, and the source theme's own colors by role:

  {"name": "Dracula", "base": "dark",
   "colors": {"bg": "#282a36", "fg": "#f8f8f2", "muted": "#6272a4", "accent": "#bd93f9", "info": "#8be9fd",
              "red": "#ff5555", "green": "#50fa7b", "yellow": "#f1fa8c", "orange": "#ffb86c",
              "blue": "#8be9fd", "purple": "#bd93f9", "pink": "#ff79c6", "cyan": "#8be9fd"}}

Every other token of the theme is a blend of those.
"""

import json
import os
import re
import sys

ROLES = ["bg", "fg", "muted", "accent", "info", "red", "green", "yellow", "orange", "blue", "purple", "pink", "cyan"]
BASES = ["dark", "light", "dark-ansi", "light-ansi", "dark-daltonized", "light-daltonized"]
WHITE, BLACK = (255, 255, 255), (0, 0, 0)
# The least contrast with the background that secondary text keeps.
INACTIVE_CONTRAST = 3.5

Color = tuple[int, int, int]


def rgb(color: str) -> Color:
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def mix(a: Color, b: Color, share: float) -> Color:
    """`share` of the way from a to b."""
    red, green, blue = (round(x + (y - x) * share) for x, y in zip(a, b))
    return red, green, blue


def luminance(color: Color) -> float:
    def channel(value: float) -> float:
        value /= 255
        return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(value) for value in color)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: Color, b: Color) -> float:
    lighter, darker = sorted((luminance(a), luminance(b)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def legible(color: Color, bg: Color, fg: Color) -> Color:
    """The color, moved toward the foreground until it keeps INACTIVE_CONTRAST with the background."""
    for step in range(21):
        candidate = mix(color, fg, step / 20)
        if contrast(candidate, bg) >= INACTIVE_CONTRAST:
            return candidate
    return fg


# MARK: Palette to theme


def read_palette(path: str) -> dict:
    with open(path) as handle:
        palette = json.load(handle)
    problems = []
    if not isinstance(palette.get("name"), str) or not palette["name"]:
        problems.append('"name" must be the theme\'s name')
    if palette.get("base") not in BASES:
        problems.append(f'"base" must be one of {", ".join(BASES)}')
    colors = palette.get("colors", {})
    for role in ROLES:
        if not isinstance(colors.get(role), str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", colors[role]):
            problems.append(f'"colors.{role}" must be a color like #1a2b3c, with no alpha')
    for role in colors:
        if role not in ROLES:
            problems.append(f'"colors.{role}" is not a role; the roles are {", ".join(ROLES)}')
    if problems:
        sys.exit(f"{path}:\n  " + "\n  ".join(problems))
    return palette


def token_groups(colors: dict[str, str]) -> list[dict[str, Color]]:
    """The theme's tokens, in the groups the theme file sets apart with blank lines."""
    c = {role: rgb(color) for role, color in colors.items()}
    bg, fg, accent = c["bg"], c["fg"], c["accent"]
    inactive = legible(c["muted"], bg, fg)
    shimmer = mix(accent, WHITE, 0.33)
    return [
        dict(claude=accent, claudeShimmer=shimmer, clawd_body=accent, text=fg, inverseText=bg, inactive=inactive,
             inactiveShimmer=mix(inactive, fg, 0.8), subtle=mix(bg, inactive, 0.7), suggestion=accent, permission=accent,
             permissionShimmer=shimmer, remember=c["info"], skill=accent),
        dict(success=c["green"], error=c["red"], warning=c["yellow"], warningShimmer=mix(c["yellow"], WHITE, 0.33), merged=c["purple"]),
        dict(promptBorder=mix(bg, accent, 0.62), promptBorderShimmer=accent, planMode=c["cyan"], autoAccept=accent,
             autoAcceptShimmer=shimmer, bashBorder=c["pink"], ide=c["info"], fastMode=c["orange"],
             fastModeShimmer=mix(c["orange"], WHITE, 0.15), effortUltra=accent),
        dict(diffAdded=mix(bg, c["green"], 0.31), diffAddedDimmed=mix(bg, c["green"], 0.16), diffAddedWord=mix(bg, c["green"], 0.53),
             diffRemoved=mix(bg, c["red"], 0.35), diffRemovedDimmed=mix(bg, c["red"], 0.18), diffRemovedWord=mix(bg, c["red"], 0.60)),
        dict(userMessageBackground=mix(bg, accent, 0.12), userMessageBackgroundHover=mix(bg, accent, 0.19),
             bashMessageBackgroundColor=mix(bg, c["pink"], 0.16), memoryBackgroundColor=mix(bg, c["info"], 0.16),
             composerSidebarBackground=mix(bg, BLACK, 0.15), selectionBg=mix(bg, accent, 0.41)),
        dict(rate_limit_fill=accent, rate_limit_empty=mix(bg, fg, 0.10), briefLabelYou=c["info"], briefLabelClaude=accent),
        dict(red_FOR_SUBAGENTS_ONLY=c["red"], blue_FOR_SUBAGENTS_ONLY=c["blue"], green_FOR_SUBAGENTS_ONLY=c["green"],
             yellow_FOR_SUBAGENTS_ONLY=c["yellow"], purple_FOR_SUBAGENTS_ONLY=c["purple"], orange_FOR_SUBAGENTS_ONLY=c["orange"],
             pink_FOR_SUBAGENTS_ONLY=c["pink"], cyan_FOR_SUBAGENTS_ONLY=c["cyan"]),
    ]


def theme_text(palette: dict) -> str:
    groups = token_groups(palette["colors"])
    blocks = [",\n".join(f'    "{token}": "#{r:02x}{g:02x}{b:02x}"' for token, (r, g, b) in group.items()) for group in groups]
    body = ",\n\n".join(blocks)
    return f'{{\n  "name": {json.dumps(palette["name"])},\n  "base": {json.dumps(palette["base"])},\n  "overrides": {{\n{body}\n  }}\n}}\n'


def slug_of(palette_path: str) -> str:
    return os.path.splitext(os.path.basename(palette_path))[0]


def build(palette_path: str, out_dir: str) -> None:
    palette = read_palette(palette_path)
    path = os.path.join(out_dir, slug_of(palette_path) + ".json")
    if os.path.abspath(path) == os.path.abspath(palette_path):
        sys.exit(f"{path} is the palette itself. The theme file takes the same name, so give --out another folder.")
    with open(path, "w") as out:
        out.write(theme_text(palette))
    tokens = {token: color for group in token_groups(palette["colors"]) for token, color in group.items()}
    bg = tokens["inverseText"]
    print(f"wrote {path}")
    print("contrast with the background: " + ", ".join(f"{token} {contrast(tokens[token], bg):.1f}" for token in ("text", "inactive", "claude", "success", "error", "warning")))


def check(palettes_dir: str, themes_dir: str) -> None:
    stale = []
    for name in sorted(os.listdir(palettes_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(themes_dir, name)
        current = open(path).read() if os.path.exists(path) else None
        if current != theme_text(read_palette(os.path.join(palettes_dir, name))):
            stale.append(name)
    if stale:
        sys.exit("not built from its palette: " + ", ".join(stale))
    print("every palette's theme file is current")


def main() -> None:
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "--check":
        check(args[1], args[2])
    elif len(args) == 3 and args[1] == "--out" and not args[0].startswith("-"):
        build(args[0], args[2])
    else:
        sys.exit(__doc__)


main()
