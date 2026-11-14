#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SurfCore 视频渲染的受控 Pillow 助手（阶段一）。

为什么用 Python 脚本而不是让 JS 直接给 FFmpeg 传滤镜：
  · drawtext 需要 libass/freetype 支持，本机 FFmpeg 构建没有（方案 §1 已验证）；
  · Pillow 渲染中文字幕 PNG 再 overlay 是已验证的备用路径；
  · 脚本只接受白名单参数，不接受任意滤镜表达式（安全约定）。

子命令：
  probe            —— 探测 python/pillow/中文字体覆盖，输出 JSON
  card             —— 生成纯色/渐变/几何卡片 PNG（1280x720）
  text             —— 把一段文字渲染成透明底 PNG（字幕/标题卡/封面字）
  cover            —— 底图 + 标题文字合成封面
所有命令失败时输出 JSON 到 stdout 并以非零码退出，方便 JS 侧解析。
"""
import json
import os
import sys

FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    # Windows
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    # Linux
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]

PROBE_GLYPHS = "鱼姬的第一份视频草稿中文字幕测试：Hello 2026！？，。—…"


def fail(code, message):
    print(json.dumps({"ok": False, "code": code, "error": message}, ensure_ascii=False))
    sys.exit(1)


def require_pillow():
    try:
        from PIL import Image, ImageDraw, ImageFont  # noqa: F401
        return Image, ImageDraw, ImageFont
    except Exception as e:
        fail("VIDEO_NO_PILLOW", f"没有 Pillow（pip install Pillow）：{e}")


def load_font(path, size):
    from PIL import ImageFont
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return None


def find_font(min_glyph_ratio=0.95):
    """返回第一个能覆盖 PROBE_GLYPHS 的中文字体路径；都没有则返回覆盖率最高的。"""
    from PIL import ImageFont
    best = None
    best_ratio = 0.0
    details = []
    for candidate in FONT_CANDIDATES:
        if not os.path.exists(candidate):
            continue
        font = load_font(candidate, 40)
        if font is None:
            details.append({"path": candidate, "ok": False, "ratio": 0})
            continue
        missing = [ch for ch in PROBE_GLYPHS if not ch.isspace() and font.getmask(ch).getbbox() is None]
        ratio = 1.0 - len(missing) / max(1, sum(1 for ch in PROBE_GLYPHS if not ch.isspace()))
        details.append({"path": candidate, "ok": True, "ratio": round(ratio, 4), "missing": missing[:12]})
        if ratio > best_ratio:
            best_ratio, best = ratio, candidate
        if ratio >= min_glyph_ratio:
            return candidate, details
    return best, details


def wrap_lines(draw, font, text, max_width, max_lines):
    """按字符换行；放不下就逐级缩小字号（不低于 min_size）；仍放不下截断加省略号。"""
    size = font.size
    while size >= 24:
        f = load_font(font.path, size) or font
        lines = []
        line = ""
        consumed = 0
        for ch in text:
            trial = line + ch
            if draw.textlength(trial, font=f) <= max_width:
                line = trial
                consumed += 1
            else:
                if line:
                    lines.append(line)
                if len(lines) >= max_lines:
                    break
                line = ch
                consumed += 1
        if line and len(lines) < max_lines:
            lines.append(line)
        if consumed == len(text) and all(draw.textlength(row, font=f) <= max_width for row in lines):
            return lines, f
        size -= 6

    # 截断时按实测像素留出省略号位置，比例字体的字宽各不相同。
    f = load_font(font.path, 24) or font
    lines = [""]
    for ch in text:
        if draw.textlength(lines[-1] + ch, font=f) > max_width:
            if len(lines) >= max_lines:
                while lines[-1] and draw.textlength(lines[-1] + "…", font=f) > max_width:
                    lines[-1] = lines[-1][:-1]
                lines[-1] += "…"
                break
            lines.append("")
        lines[-1] += ch
    return [row for row in lines if row], f


def cmd_probe(args=None):
    try:
        import PIL
        pillow = PIL.__version__
    except Exception as e:
        print(json.dumps({"ok": True, "pillow": None, "pillowError": str(e), "fonts": []}, ensure_ascii=False))
        return
    font_path, details = find_font()
    result = {
        "ok": True,
        "python": sys.version.split()[0],
        "pillow": pillow,
        "font": font_path,
        "fonts": details,
    }
    print(json.dumps(result, ensure_ascii=False))


def parse_hex(value, default):
    v = str(value or "").strip().lstrip("#")
    if len(v) == 6:
        try:
            return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return default


def cmd_card(args):
    Image, ImageDraw, ImageFont = require_pillow()
    width = int(args.get("--width", 1280))
    height = int(args.get("--height", 720))
    kind = args.get("--kind", "color")
    color = parse_hex(args.get("--color"), (43, 58, 85))
    color2 = parse_hex(args.get("--color2"), (24, 32, 48))
    accent = parse_hex(args.get("--accent"), (255, 255, 255))
    img = Image.new("RGB", (width, height), color)
    draw = ImageDraw.Draw(img)
    if kind == "gradient":
        for y in range(height):
            t = y / max(1, height - 1)
            row = tuple(int(c1 + (c2 - c1) * t) for c1, c2 in zip(color, color2))
            draw.line([(0, y), (width, y)], fill=row)
    if kind in ("gradient", "geometry"):
        # 右上角大圆环装饰 + 左下小圆
        cx, cy, r = int(width * 0.82), int(height * 0.18), int(min(width, height) * 0.30)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=accent, width=int(r * 0.10))
        cx2, cy2, r2 = int(width * 0.10), int(height * 0.88), int(min(width, height) * 0.12)
        draw.ellipse([cx2 - r2, cy2 - r2, cx2 + r2, cy2 + r2], fill=accent)
    text = str(args.get("--text", "") or "")
    if text:
        font_path = args.get("--font") or find_font()[0]
        font = ImageFont.truetype(font_path, int(args.get("--font-size", 64)))
        tw, th = draw.textbbox((0, 0), text, font=font)[2:]
        draw.text(((width - tw) / 2, (height - th) / 2), text, font=font, fill=accent)
    img.save(args["--out"], format="PNG")
    print(json.dumps({"ok": True, "file": args["--out"], "width": width, "height": height}, ensure_ascii=False))


def cmd_text(args):
    Image, ImageDraw, ImageFont = require_pillow()
    text = str(args.get("--text", "") or "")
    if not text:
        fail("VIDEO_EMPTY_TEXT", "字幕文本为空")
    width = int(args.get("--width", 1280))
    height = int(args.get("--height", 720))
    fill = parse_hex(args.get("--fill"), (255, 255, 255))
    stroke = parse_hex(args.get("--stroke"), (20, 20, 24))
    stroke_w = int(args.get("--stroke-width", 5))
    align = args.get("--align", "bottom")          # bottom | center | top
    padding_x = int(args.get("--padding-x", 80))
    padding_y = int(args.get("--padding-y", 96))
    max_lines = int(args.get("--max-lines", 2))
    font_path = args.get("--font") or find_font()[0]
    if not font_path:
        fail("VIDEO_NO_FONT", "找不到可用中文字体（安装 PingFang/Noto Sans CJK 或设置 --font）")
    font = ImageFont.truetype(font_path, int(args.get("--font-size", 52)))
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    lines, used_font = wrap_lines(draw, font, text, width - 2 * padding_x, max_lines)
    # 半透明底衬，提高复杂画面上的可读性
    line_h = used_font.size + int(used_font.size * 0.34)
    block_h = line_h * len(lines) + 24
    if align == "bottom":
        top = height - padding_y - block_h
    elif align == "top":
        top = padding_y
    else:
        top = (height - block_h) / 2
    left = (width - (max((draw.textlength(l, font=used_font) for l in lines), default=0))) / 2 - 18
    right = left + max((draw.textlength(l, font=used_font) for l in lines), default=0) + 36
    draw.rectangle([left, top, right, top + block_h], fill=(0, 0, 0, 96))
    y = top + 12
    for line in lines:
        draw.text(((width - draw.textlength(line, font=used_font)) / 2, y), line,
                  font=used_font, fill=fill, stroke_width=stroke_w, stroke_fill=stroke)
        y += line_h
    img.save(args["--out"], format="PNG")
    missing = [ch for ch in text if not ch.isspace() and used_font.getmask(ch).getbbox() is None]
    print(json.dumps({
        "ok": True, "file": args["--out"], "lines": lines,
        "fontSize": used_font.size, "fitted": "".join(lines) == text,
        "missingGlyphs": missing[:20],
    }, ensure_ascii=False))


def cmd_cover(args):
    Image, ImageDraw, ImageFont = require_pillow()
    base = args.get("--base")
    if not base or not os.path.exists(base):
        fail("VIDEO_COVER_BASE", "封面底图不存在")
    try:
        img = Image.open(base).convert("RGB")
    except Exception as e:
        fail("VIDEO_COVER_DECODE", f"封面底图无法解码：{e}")
    width, height = 1280, 720
    img = img.resize((width, height), Image.LANCZOS)
    headline = str(args.get("--headline", "") or "").strip()
    if headline:
        draw = ImageDraw.Draw(img)
        font_path = args.get("--font") or find_font()[0]
        if not font_path:
            fail("VIDEO_NO_FONT", "找不到可用中文字体")
        font = ImageFont.truetype(font_path, int(args.get("--font-size", 64)))
        lines, used_font = wrap_lines(draw, font, headline, width - 160, 2)
        # 底部渐变遮罩压暗，保证白字可读
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        odraw = ImageDraw.Draw(overlay)
        for y in range(int(height * 0.55), height):
            alpha = int(180 * (y - height * 0.55) / (height * 0.45))
            odraw.line([(0, y), (width, y)], fill=(8, 10, 16, alpha))
        img = Image.alpha_composite(img.convert("RGBA"), overlay)
        draw = ImageDraw.Draw(img)
        y = height - 120 - used_font.size * len(lines)
        for line in lines:
            tw = draw.textlength(line, font=used_font)
            draw.text(((width - tw) / 2, y), line, font=used_font,
                      fill=(255, 255, 255), stroke_width=4, stroke_fill=(10, 12, 18))
            y += used_font.size + 12
    img.convert("RGB").save(args["--out"], format="PNG")
    print(json.dumps({"ok": True, "file": args["--out"], "width": width, "height": height}, ensure_ascii=False))


COMMANDS = {"probe": cmd_probe, "card": cmd_card, "text": cmd_text, "cover": cmd_cover}


def main():
    if len(sys.argv) < 2:
        fail("VIDEO_USAGE", "用法: caption-render.py <probe|card|text|cover> [--key value ...]")
    cmd = sys.argv[1]
    if cmd not in COMMANDS:
        fail("VIDEO_USAGE", f"未知子命令 {cmd}")
    args = {}
    rest = sys.argv[2:]
    i = 0
    while i < len(rest):
        key = rest[i]
        if not key.startswith("--"):
            fail("VIDEO_USAGE", f"参数必须是 --key value：{key}")
        value = rest[i + 1] if i + 1 < len(rest) and not rest[i + 1].startswith("--") else ""
        args[key] = value
        i += 2
    args["--out"] = args.get("--out") or os.path.join(os.getcwd(), "out.png")
    os.makedirs(os.path.dirname(os.path.abspath(args["--out"])), exist_ok=True)
    try:
        COMMANDS[cmd](args)
    except SystemExit:
        raise
    except Exception as e:
        fail("VIDEO_PY_FAILED", f"{cmd} 执行失败：{e}")


if __name__ == "__main__":
    main()
