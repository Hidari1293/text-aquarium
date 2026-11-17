"""Generate the app icon: one character fish on white paper.

Kept in the repo so the icon is reproducible instead of being a mystery binary.

    python scripts/make-icon.py        # -> src-tauri/icons/source.png
    npx tauri icon src-tauri/icons/source.png
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
INK = (17, 17, 17, 255)
PAPER = (255, 255, 255, 255)
GLYPH = "><(((o>"

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons" / "source.png"


def load_font(px: int) -> ImageFont.FreeTypeFont:
    for name in ("consola.ttf", "cour.ttf", "lucon.ttf"):
        path = Path("C:/Windows/Fonts") / name
        if path.exists():
            return ImageFont.truetype(str(path), px)
    return ImageFont.load_default()


def main() -> None:
    image = Image.new("RGB", (SIZE, SIZE), PAPER)
    draw = ImageDraw.Draw(image)

    border = 26
    draw.rectangle(
        [border // 2, border // 2, SIZE - border // 2 - 1, SIZE - border // 2 - 1],
        outline=INK,
        width=border,
    )

    font = load_font(150)
    box = draw.textbbox((0, 0), GLYPH, font=font)
    x = (SIZE - (box[2] - box[0])) / 2 - box[0]
    y = (SIZE - (box[3] - box[1])) / 2 - box[1]
    draw.text((x, y), GLYPH, font=font, fill=INK)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT)
    print(f"wrote {OUT} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
