"""阶段 2｜风格分析：测出素材的节奏画像，交给 Jev 判断，由代码做模板路由。

三层分工，对应「模型给判断、代码做决策」：

  1. **测量**（本脚本，确定性、不花 token）：镜头切点与长度分布、静音间隙、语速、亮度/饱和度。
  2. **判断**（Jev）：`sysone_ask` 一次问全，返回**标定过的概率与置信度**。
  3. **决策**（`sysone_compose`）：按置信度门控成 act / review / escalate，决定选哪个模板，
     或者干脆升级给人 —— 而不是让模型硬选一个。

三次调用，本脚本负责头尾与所有文件格式：

    python draft_analyze.py measure [--srt x.srt]     # → measures.json + questions.json
    #   agent 用 sysone_ask 问两次、sysone_compose 路由一次，把原始输出存成 jev.json
    python draft_analyze.py decide jev.json           # → style.json（离开本阶段的凭据）
    python draft_analyze.py skip --reason "..."       # 不做分析，但要留下记录

用法见 SKILL.md 的「风格分析」一节。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import fail, load_json, media_dir, ok, save_json, work_dir  # noqa: E402

#: 判定为「一次切镜」的画面变化阈值（0~1）。低于它会开始把运动、光照当切点。
SCENE_THRESHOLD = 0.30

#: 静音判定：低于这个音量、且持续这么久，算一段静音。
SILENCE_NOISE = "-30dB"
SILENCE_MIN_SECONDS = 0.35

#: 模板注册表所在的子目录（相对 `<stateDir>/draft/`）。
TEMPLATE_DIR = "templates"

#: 认作视频素材的扩展名。
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}


def run_ffmpeg(args: list[str]) -> str:
    """跑一次 ffmpeg，把 stderr 原样收回来（滤镜的分析输出都在 stderr）。"""
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *args],
                          capture_output=True, text=True, check=False)
    return proc.stderr or ""


def probe_duration(path: Path) -> float:
    """用 ffprobe 读总时长（秒）。"""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=False)
    try:
        return float((proc.stdout or "0").strip())
    except ValueError:
        return 0.0


def detect_cuts(video: Path, duration: float) -> list[float]:
    """用 ffmpeg 的 scene 滤镜找切点，返回时间戳（秒）。"""
    out = run_ffmpeg([
        "-i", str(video),
        "-filter:v", f"select='gt(scene,{SCENE_THRESHOLD})',showinfo",
        "-an", "-f", "null", "-",
    ])
    cuts = sorted({float(m) for m in re.findall(r"pts_time:([0-9]+\.?[0-9]*)", out)})
    return [t for t in cuts if 0.05 < t < duration - 0.05]


def detect_silences(video: Path) -> list[dict[str, float]]:
    """用 silencedetect 找静音段。"""
    out = run_ffmpeg([
        "-i", str(video),
        "-af", f"silencedetect=noise={SILENCE_NOISE}:d={SILENCE_MIN_SECONDS}",
        "-f", "null", "-",
    ])
    spans: list[dict[str, float]] = []
    start: float | None = None
    for match in re.finditer(r"silence_(start|end): ([0-9]+\.?[0-9]*)", out):
        kind, value = match.group(1), float(match.group(2))
        if kind == "start":
            start = value
        elif start is not None:
            spans.append({"start": start, "end": value, "duration": round(value - start, 3)})
            start = None
    return spans


def color_stats(video: Path) -> dict[str, float]:
    """按秒采样，算亮度与饱和度的均值。"""
    out = run_ffmpeg([
        "-i", str(video), "-vf", "fps=1,signalstats,metadata=print",
        "-an", "-f", "null", "-",
    ])
    def mean(key: str) -> float:
        values = [float(v) for v in re.findall(rf"lavfi\.signalstats\.{key}=([0-9]+\.?[0-9]*)", out)]
        return round(sum(values) / len(values), 1) if values else 0.0
    return {"luma": mean("YAVG"), "saturation": mean("SATAVG")}


def speech_rate(srt: Path) -> dict[str, float]:
    """从 SRT 估语速：字/秒（中文按字算，西文按词算）。"""
    text = srt.read_text(encoding="utf-8", errors="ignore")
    chars = 0
    seconds = 0.0
    pattern = re.compile(
        r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*\n(.+?)(?=\n\s*\n|\Z)",
        re.S)
    for m in pattern.finditer(text):
        start = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000
        end = int(m.group(5)) * 3600 + int(m.group(6)) * 60 + int(m.group(7)) + int(m.group(8)) / 1000
        body = re.sub(r"<[^>]+>", "", m.group(9)).strip()
        seconds += max(0.0, end - start)
        # 汉字各算一个单位，连续的西文字母算一个词
        chars += len(re.findall(r"[\u4e00-\u9fff]", body)) + len(re.findall(r"[A-Za-z]+", body))
    if seconds <= 0:
        return {"unitsPerSecond": 0.0, "coveredSeconds": 0.0}
    return {"unitsPerSecond": round(chars / seconds, 2), "coveredSeconds": round(seconds, 1)}


def summarize_shots(cuts: list[float], duration: float) -> dict[str, Any]:
    """把切点换算成镜头长度分布。"""
    bounds = [0.0, *cuts, duration]
    lengths = [round(b - a, 2) for a, b in zip(bounds, bounds[1:]) if b - a > 0.01]
    if not lengths:
        return {"count": 0, "meanS": 0.0, "medianS": 0.0, "minS": 0.0, "maxS": 0.0, "cutsPerMinute": 0.0}
    ordered = sorted(lengths)
    mid = len(ordered) // 2
    median = ordered[mid] if len(ordered) % 2 else round((ordered[mid - 1] + ordered[mid]) / 2, 2)
    return {
        "count": len(lengths),
        "meanS": round(sum(lengths) / len(lengths), 2),
        "medianS": median,
        "minS": ordered[0],
        "maxS": ordered[-1],
        "cutsPerMinute": round(len(cuts) / duration * 60, 1) if duration > 0 else 0.0,
    }


def load_templates() -> list[dict[str, Any]]:
    """读模板注册表：`<stateDir>/draft/templates/<名字>/template.json`。"""
    root = work_dir() / TEMPLATE_DIR
    if not root.is_dir():
        return []
    found: list[dict[str, Any]] = []
    for entry in sorted(root.iterdir()):
        spec = entry / "template.json"
        if not spec.is_file():
            continue
        try:
            value = json.loads(spec.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 —— 单个坏模板不该让整个分析失败
            continue
        if isinstance(value, dict) and value.get("name"):
            found.append({"dir": entry.name, **value})
    return found


def build_questions(measures: dict[str, Any], templates: list[dict[str, Any]]) -> dict[str, Any]:
    """按测量结果生成要问 Jev 的问题集。"""
    shots = measures["shots"]
    profile = {
        "state": (
            f"素材测量数据（客观测得，非观感）：时长 {measures['durationS']}s，"
            f"共 {shots['count']} 个镜头，平均镜头 {shots['meanS']}s，中位 {shots['medianS']}s，"
            f"最短 {shots['minS']}s，最长 {shots['maxS']}s，每分钟 {shots['cutsPerMinute']} 个切点；"
            f"静音段 {measures['silence']['count']} 处、合计 {measures['silence']['totalS']}s、"
            f"最长一处 {measures['silence']['longestS']}s；"
            f"画面平均亮度 {measures['color']['luma']}（0-255）、平均饱和度 {measures['color']['saturation']}。"
            + (f"人声语速约 {measures['speech']['unitsPerSecond']} 单位/秒。"
               if measures["speech"]["unitsPerSecond"] > 0 else "没有人声转写，语速未知。")
        ),
        "questions": [
            {
                "id": "pacing",
                "type": "choice",
                "instructions": "按上面的镜头长度分布，这条片子的剪辑节奏应该定成哪一档？",
                "criteria": {
                    "fast": "快切：平均镜头 2s 以内，靠密度与卡点推进",
                    "mid": "中速：平均镜头 2-5s，叙述与画面平衡",
                    "slow": "慢叙：平均镜头 5s 以上，留白与情绪为主",
                },
            },
            {
                "id": "content",
                "type": "choice",
                "instructions": "这条素材更像哪一类内容？",
                "criteria": {
                    "talking_head": "口播/访谈：以人说话为主，画面变化少",
                    "tutorial": "教程演示：有屏幕录制或操作步骤",
                    "montage": "混剪：多段素材拼接，无明显单一主体",
                    "narrative": "叙事 vlog：按时间或事件推进",
                    "product": "产品展示：围绕一个物件的多角度呈现",
                },
            },
            {
                "id": "density",
                "type": "score",
                "instructions": "这条素材的信息密度有多高？",
                "criteria": [
                    "几乎没有新信息，大量重复与留白",
                    "信息很少，以氛围为主",
                    "信息偏少，节奏舒缓",
                    "信息量中等偏低",
                    "信息量中等",
                    "信息量中等偏上",
                    "每段都有明确新信息",
                    "信息密集，几乎没有废话",
                    "信息很密集，需要字幕辅助",
                    "信息极密集，每一句都是新信息",
                ],
            },
            {
                "id": "energy",
                "type": "score",
                "instructions": "这条素材的整体情绪能量有多强？",
                "criteria": [
                    "极其平静克制",
                    "平静",
                    "偏冷静",
                    "温和",
                    "中性",
                    "略有起伏",
                    "有明确情绪起伏",
                    "情绪较强",
                    "情绪强烈",
                    "情绪很外放，接近广告片",
                ],
            },
            {
                "id": "voice_led",
                "type": "noul",
                "instructions": "这条素材的推进主要靠人声（而不是画面或音乐）吗？",
            },
            {
                "id": "need_caption",
                "type": "noul",
                "instructions": "这条片子需要烧录字幕吗？",
            },
        ],
    }

    for question in profile["questions"]:
        if question["type"] != "score":
            continue
        count = len(question["criteria"])
        if not 2 <= count <= 10:
            fail(f"内部错误：{question['id']} 有 {count} 档，而 Jev 只接受 2~10 档")

    if not templates:
        return {"profile": profile, "template": None}

    criteria = {}
    for tpl in templates:
        bits = [str(tpl.get("summary", "")).strip()]
        if tpl.get("aspect"):
            bits.append(f"画幅 {tpl['aspect']}")
        if tpl.get("idealPacing"):
            bits.append(f"适合节奏 {tpl['idealPacing']}")
        if tpl.get("idealContent"):
            bits.append("适合内容 " + "/".join(str(x) for x in tpl["idealContent"]))
        criteria[str(tpl["name"])] = "；".join(b for b in bits if b)

    return {
        "profile": profile,
        "template": {
            "state": "候选模板如下（每个模板是一份可在剪映里继续编辑的草稿）。请结合素材的风格画像选择最适配的一个。",
            "questions": [{
                "id": "template",
                "type": "choice",
                "instructions": "哪个模板最适配这条素材？",
                "criteria": criteria,
            }],
        },
    }


def pick_video(argv: list[str]) -> Path:
    """挑出要分析的主素材。

    顺序：显式传的目录 → `survey.json` 里时长最长的视频 → 素材目录里第一个视频。
    「接着盘点结论走」比重新猜目录可靠：盘点阶段已经确认过素材在哪、哪个多长。
    """
    explicit = [a for a in argv if not a.startswith("--")]
    if explicit:
        root = Path(explicit[0]).expanduser().resolve()
        videos = sorted(p for p in root.glob("*") if p.suffix.lower() in VIDEO_EXT)
        if not videos:
            fail(f"{root} 里没有视频素材")
        return videos[0]

    survey_path = work_dir() / "survey.json"
    if survey_path.is_file():
        try:
            survey = json.loads(survey_path.read_text(encoding="utf-8"))
            assets = [a for a in (survey.get("assets") or [])
                      if a.get("kind") == "video" and not a.get("error")]
            if assets:
                main = max(assets, key=lambda a: int(a.get("durationUs") or 0))
                path = Path(str(main["path"]))
                if path.is_file():
                    return path
        except Exception:  # noqa: BLE001 —— 盘点结果坏了就退回扫目录
            pass

    root = media_dir()
    videos = sorted(p for p in root.rglob("*") if p.suffix.lower() in VIDEO_EXT)
    if not videos:
        fail(f"{root} 里没有视频素材。可以显式指定目录：draft_analyze.py measure <素材目录>")
    return videos[0]


def cmd_measure(argv: list[str]) -> int:
    """测量 + 生成问题。"""
    srt: Path | None = None
    if "--srt" in argv:
        index = argv.index("--srt")
        try:
            srt = Path(argv[index + 1]).expanduser().resolve()
        except IndexError:
            fail("--srt 后面要跟文件路径")

    video = pick_video(argv)
    duration = probe_duration(video)
    if duration <= 0:
        fail(f"读不到 {video} 的时长")

    cuts = detect_cuts(video, duration)
    silences = detect_silences(video)
    measures = {
        "video": str(video),
        "durationS": round(duration, 2),
        "shots": summarize_shots(cuts, duration),
        "cuts": [round(c, 2) for c in cuts],
        "silence": {
            "count": len(silences),
            "totalS": round(sum(s["duration"] for s in silences), 2),
            "longestS": round(max((s["duration"] for s in silences), default=0.0), 2),
            "spans": silences[:40],
        },
        "color": color_stats(video),
        "speech": speech_rate(srt) if srt is not None and srt.is_file() else {"unitsPerSecond": 0.0, "coveredSeconds": 0.0},
    }

    save_json(work_dir() / "measures.json", measures)
    questions = build_questions(measures, load_templates())
    save_json(work_dir() / "questions.json", questions)

    shots = measures["shots"]
    ok(f"测量完成：{shots['count']} 个镜头，平均 {shots['meanS']}s，"
       f"{measures['silence']['count']} 处静音，语速 {measures['speech']['unitsPerSecond']} 单位/秒")
    ok(f"→ {work_dir() / 'measures.json'} / questions.json")
    ok("")
    ok("下一步（agent 做，脚本不能调 Jev）：")
    ok("  1. sysone_ask  state=questions.json 的 profile.state  questions=profile.questions")
    if questions["template"] is not None:
        ok("  2. sysone_ask  state 带上第 1 步的答案摘要  questions=template.questions")
        ok("  3. sysone_compose mode=route  answers=[第 2 步的 template 答案]")
    ok("  把这三步的**原始输出**存成 jev.json，再跑：draft_analyze.py decide jev.json")
    return 0


#: `sysone_ask` 渲染出的答案行，例如
#: `  pacing: choice=mid  confidence=0.99 probabilities={slow=0, fast=0, mid=1} calibrated`
ASK_LINE = re.compile(
    r"^\s*(?P<id>[A-Za-z0-9_.\-]+):\s*"
    r"(?:choice=(?P<choice>\S+)|score=(?P<score>[0-9.]+)/(?P<scale>[0-9]+)|noul=(?P<noul>[0-9.]+))"
    r"\s+confidence=(?P<confidence>[0-9.]+)"
    r"\s+probabilities=\{(?P<probs>[^}]*)\}",
    re.M,
)

#: `sysone_compose mode=route` 的首行：`sysone_compose · mode=route · template → act`
ROUTE_HEAD = re.compile(r"mode=route\s*·\s*(?P<target>\S+)\s*→\s*(?P<decision>[a-z]+)")
#: 紧随其后的一行：`  依据：confidence 0.99 ≥ 0.70：直接执行`
ROUTE_REASON = re.compile(r"依据：\s*(?P<reason>.+)")


def parse_ask_text(text: str) -> list[dict[str, Any]]:
    """把 `sysone_ask` 的渲染文本解析回结构化答案。

    模型只看得到渲染后的文本（结构化 `answers` 在工具返回值里，但界面只渲染 text），
    所以这一层解析是必需的 —— 否则只能让人手工重建，那正是出错的地方。
    """
    out: list[dict[str, Any]] = []
    for match in ASK_LINE.finditer(text):
        probabilities: dict[str, float] = {}
        for pair in match.group("probs").split(","):
            key, sep, value = pair.partition("=")
            if sep == "":
                continue
            try:
                probabilities[key.strip()] = float(value)
            except ValueError:
                continue
        answer: dict[str, Any] = {
            "id": match.group("id"),
            "confidence": float(match.group("confidence")),
            "probabilities": probabilities,
            "calibrated": True,
        }
        if match.group("choice") is not None:
            answer |= {"type": "choice", "choice": match.group("choice")}
        elif match.group("score") is not None:
            answer |= {"type": "score", "score": float(match.group("score")),
                       "scaleMax": int(match.group("scale"))}
        else:
            answer |= {"type": "noul", "noul": float(match.group("noul"))}
        out.append(answer)
    return out


def _text_of(block: Any) -> str:
    """从一块里挖出可解析的文本：agent 存的可能是结构化对象，也可能是原始文本。"""
    if isinstance(block, str):
        return block
    if isinstance(block, dict):
        for key in ("text", "raw", "output"):
            if isinstance(block.get(key), str):
                return str(block[key])
    return ""


def _answers(jev: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """取某一次 `sysone_ask` 的答案：结构化优先，只有文本就解析文本。"""
    block = jev.get(key)
    if isinstance(block, dict) and isinstance(block.get("answers"), list):
        return [a for a in block["answers"] if isinstance(a, dict)]
    return parse_ask_text(_text_of(block))


def _route(jev: dict[str, Any]) -> dict[str, Any] | None:
    """取 `sysone_compose` 的路由结果：结构化优先，否则解析文本。"""
    block = jev.get("route")
    if isinstance(block, dict) and isinstance(block.get("decision"), str):
        return block
    text = _text_of(block)
    head = ROUTE_HEAD.search(text)
    if head is None:
        return None
    reason = ROUTE_REASON.search(text)
    return {
        "mode": "route",
        "target": head.group("target"),
        "decision": head.group("decision"),
        "reason": reason.group("reason").strip() if reason is not None else "",
    }


def cmd_decide(argv: list[str]) -> int:
    """合并 Jev 的判断与路由，写 style.json。"""
    if not argv:
        fail("用法：draft_analyze.py decide jev.json")
    jev = load_json(Path(argv[0]).expanduser().resolve())
    if not isinstance(jev, dict):
        fail("jev.json 必须是一个 JSON 对象")
    measures = load_json(work_dir() / "measures.json")

    profile = _answers(jev, "profile")
    if not profile:
        fail("jev.json 里缺少 profile（第一次 sysone_ask 的原始输出）")
    by_id = {str(a.get("id")): a for a in profile}
    template = _answers(jev, "template")
    tpl = template[0] if template else None
    route = _route(jev)

    if tpl is None:
        decision: dict[str, Any] = {"action": "no-template", "reason": "没有候选模板，按素材自行构建"}
    elif route is None:
        decision = {
            "action": "unrouted",
            "reason": "没有 sysone_compose 的路由结果，模板选择请人确认",
            "suggested": tpl.get("choice"),
            "confidence": tpl.get("confidence"),
        }
    else:
        verdict = route.get("decision")
        decision = {
            "action": verdict,
            "reason": route.get("reason"),
            "chosen": tpl.get("choice") if verdict == "act" else None,
            "suggested": tpl.get("choice") if verdict == "review" else None,
            "alsoNotify": route.get("alsoNotify"),
        }

    style = {
        "video": measures.get("video"),
        "measures": {
            "durationS": measures.get("durationS"),
            "shots": measures.get("shots"),
            "silence": {k: v for k, v in (measures.get("silence") or {}).items() if k != "spans"},
            "color": measures.get("color"),
            "speech": measures.get("speech"),
        },
        "profile": {
            "pacing": by_id.get("pacing", {}).get("choice"),
            "content": by_id.get("content", {}).get("choice"),
            "density": by_id.get("density", {}).get("score"),
            "energy": by_id.get("energy", {}).get("score"),
            "voice_led": by_id.get("voice_led", {}).get("noul"),
            "need_caption": by_id.get("need_caption", {}).get("noul"),
            "answers": profile,
        },
        "template": tpl,
        "decision": decision,
    }
    save_json(work_dir() / "style.json", style)

    spec = style["profile"]
    ok(f"风格：节奏 {spec['pacing']} / 内容 {spec['content']} / "
       f"密度 {spec['density']} / 能量 {spec['energy']} / "
       f"靠人声 {spec['voice_led']} / 要字幕 {spec['need_caption']}")
    if tpl is not None:
        ok(f"模板研判：{tpl.get('choice')}（置信度 {tpl.get('confidence')}）")
    ok(f"决策：{decision.get('action')} —— {decision.get('reason')}")
    if decision.get("action") == "escalate":
        fail("置信度不足以自动选模板：把候选讲给用户，定了之后写进 style.json 的 decision.chosen 再继续")
    if decision.get("action") == "review":
        ok("置信度中等：把建议的模板讲给用户，确认后再进 plan 阶段")
    ok(f"→ {work_dir() / 'style.json'}")
    return 0


def cmd_skip(argv: list[str]) -> int:
    """显式跳过分析，但留下可审计的记录。"""
    reason = ""
    if "--reason" in argv:
        index = argv.index("--reason")
        try:
            reason = argv[index + 1]
        except IndexError:
            fail("--reason 后面要跟一句原因")
    if not reason:
        fail("跳过分析必须给 --reason（会记进 style.json，闸门据此放行）")
    save_json(work_dir() / "style.json", {"skipped": True, "reason": reason})
    ok(f"已记录跳过原因 → {work_dir() / 'style.json'}")
    return 0


def main() -> int:
    """入口：measure / decide / skip。"""
    if len(sys.argv) < 2:
        fail(__doc__ or "用法：draft_analyze.py measure|decide|skip")
    command, argv = sys.argv[1], sys.argv[2:]
    if command == "measure":
        return cmd_measure(argv)
    if command == "decide":
        return cmd_decide(argv)
    if command == "skip":
        return cmd_skip(argv)
    fail(f"未知子命令：{command}（只支持 measure / decide / skip）")
    raise AssertionError


if __name__ == "__main__":
    raise SystemExit(main())
