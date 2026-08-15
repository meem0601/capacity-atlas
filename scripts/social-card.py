from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "assets" / "dashboard.png"
OUTPUT = ROOT / "docs" / "assets" / "capacity-atlas-x-card-ja.png"
W, H = 1200, 628
BG = "#090B0F"
PANEL = "#11151C"
TEXT = "#F7FAFC"
MUTED = "#A8B0BD"
ACCENT = "#5BE1B5"
BORDER = "#2A3340"
FONT_BOLD = "/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc"
FONT_REGULAR = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"

canvas = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(canvas)

# restrained background glow
for radius, alpha in [(260, 34), (170, 28), (90, 20)]:
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((500-radius, -120-radius, 500+radius, -120+radius), fill=(39, 210, 161, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(radius // 2))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), glow)

draw = ImageDraw.Draw(canvas)
brand_font = ImageFont.truetype(FONT_BOLD, 25)
headline_font = ImageFont.truetype(FONT_BOLD, 52)
body_font = ImageFont.truetype(FONT_REGULAR, 22)
small_font = ImageFont.truetype(FONT_REGULAR, 16)
badge_font = ImageFont.truetype(FONT_BOLD, 16)

# simple product mark
draw.rounded_rectangle((58, 52, 88, 82), radius=8, fill="#151B23", outline=BORDER)
for x, height in [(66, 10), (73, 18), (80, 14)]:
    draw.rounded_rectangle((x, 70-height, x+3, 70), radius=2, fill=ACCENT)
draw.text((102, 51), "Capacity Atlas", font=brand_font, fill=TEXT)

# badges
def pill(x, y, text, fill, outline, color):
    box = draw.textbbox((0, 0), text, font=badge_font)
    width = box[2] - box[0] + 30
    draw.rounded_rectangle((x, y, x+width, y+34), radius=17, fill=fill, outline=outline)
    draw.text((x+15, y+7), text, font=badge_font, fill=color)
    return x + width

x = pill(58, 112, "無料OSS", "#123028", "#245947", ACCENT)
pill(x+10, 112, "macOS / Windows", PANEL, BORDER, TEXT)

# headline and copy
draw.multiline_text((58, 176), "複数のAI利用枠を\n1画面で確認", font=headline_font, fill=TEXT, spacing=10)
draw.multiline_text((58, 322), "残容量・リセット時刻・認証状態をまとめて表示。\n認証情報と実データはPC内で管理します。", font=body_font, fill=MUTED, spacing=11)
draw.text((58, 424), "ChatGPT（Codex利用枠）/ Claude / Grok から対応開始", font=small_font, fill=TEXT)
draw.text((58, 452), "対応サービスは順次拡大", font=small_font, fill=ACCENT)

# screenshot panel
src = Image.open(SOURCE).convert("RGB")
# crop around the value-bearing dashboard, retaining the demo label
crop = src.crop((205, 70, 1430, 940))
max_w, max_h = 585, 416
scale = min(max_w / crop.width, max_h / crop.height)
crop = crop.resize((int(crop.width*scale), int(crop.height*scale)), Image.Resampling.LANCZOS)
panel_x, panel_y = 594, 104
panel_w, panel_h = 560, 420
draw.rounded_rectangle((panel_x-1, panel_y-1, panel_x+panel_w+1, panel_y+panel_h+1), radius=20, fill=PANEL, outline=BORDER, width=2)
# cover-fit crop centered in panel
scale2 = max(panel_w / crop.width, panel_h / crop.height)
shot = crop.resize((int(crop.width*scale2), int(crop.height*scale2)), Image.Resampling.LANCZOS)
left = max(0, (shot.width-panel_w)//2)
top = max(0, (shot.height-panel_h)//2)
shot = shot.crop((left, top, left+panel_w, top+panel_h))
mask = Image.new("L", (panel_w, panel_h), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, panel_w, panel_h), radius=18, fill=255)
canvas.paste(shot, (panel_x, panel_y), mask)

# explicit synthetic-data note outside the screenshot
note = "画面はデモデータ"
box = draw.textbbox((0, 0), note, font=small_font)
nw = box[2]-box[0]+24
draw.rounded_rectangle((panel_x+panel_w-nw-12, panel_y+panel_h-39, panel_x+panel_w-12, panel_y+panel_h-11), radius=14, fill="#090B0FE8", outline="#FFFFFF40")
draw.text((panel_x+panel_w-nw, panel_y+panel_h-33), note, font=small_font, fill=TEXT)

# footer promise
draw.line((58, 544, 1142, 544), fill=BORDER, width=1)
draw.text((58, 570), "ローカルファーストのAI利用枠ダッシュボード", font=small_font, fill=MUTED)
draw.text((1016, 570), "MIT License", font=small_font, fill=MUTED)

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
canvas.convert("RGB").save(OUTPUT, quality=95)
print(OUTPUT)
