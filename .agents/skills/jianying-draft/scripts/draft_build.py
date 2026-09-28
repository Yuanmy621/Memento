"""阶段 3｜草稿构建：把 plan.json 编译成一份真实的剪映草稿。

读 `<stateDir>/draft/plan.json`，在剪映草稿目录里生成草稿。产物是**可在剪映里继续
编辑的工程**，不是渲染好的视频 —— 导出由人完成（见 draft_export.py）。

用法：
    python draft_build.py [plan.json 路径]

plan.json 结构见本技能 SKILL.md 的「plan.json 怎么写」。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pyJianYingDraft as draft  # noqa: E402
from pyJianYingDraft.exceptions import SegmentOverlap  # noqa: E402

from _common import draft_store, fail, load_json, ok, work_dir  # noqa: E402

#: 可以按中文名解析的枚举类（`from_name` 忽略大小写、空格与下划线）。
ENUMS = (
    "IntroType", "OutroType", "GroupAnimationType",
    "VideoSceneEffectType", "VideoCharacterEffectType",
    "TextIntro", "TextOutro", "TextLoopAnim",
    "FilterType", "AudioSceneEffectType", "ToneEffectType",
)

#: 轨道类型名 → 枚举。
TRACK_TYPES = {
    "video": draft.TrackType.video,
    "audio": draft.TrackType.audio,
    "text": draft.TrackType.text,
    "sticker": draft.TrackType.sticker,
    "effect": draft.TrackType.effect,
    "filter": draft.TrackType.filter,
}


def parse_time(value: Any) -> int:
    """把时间写法统一成微秒：数字按秒算，字符串走剪映的时间语法（`1.5s` / `1m30s`）。"""
    if isinstance(value, bool):
        fail(f"时间不能是布尔值：{value!r}")
    if isinstance(value, (int, float)):
        return int(round(float(value) * 1_000_000))
    if isinstance(value, str):
        return int(draft.tim(value))
    fail(f"看不懂的时间写法：{value!r}")


def resolve_enum(name: str) -> Any:
    """按中文/英文名在已知枚举里找一个成员。"""
    for enum_name in ENUMS:
        enum = getattr(draft, enum_name, None)
        if enum is None or not hasattr(enum, "from_name"):
            continue
        try:
            return enum.from_name(name)
        except Exception:  # noqa: BLE001 —— from_name 未命中时的异常类型由上游决定
            continue
    fail(f"找不到名为「{name}」的动画/特效/滤镜；可用的名字见 references/pyjianyingdraft-api.md")
    raise AssertionError  # 上面的 fail 一定退出，这里只为类型收窄


def clip_settings(spec: dict[str, Any]) -> Any:
    """把 plan 里的 transform/alpha/flip 收成 `ClipSettings`；都没有则返回 None。"""
    keys = ("alpha", "flip_horizontal", "flip_vertical", "rotation",
            "scale_x", "scale_y", "transform_x", "transform_y")
    if not any(key in spec for key in keys):
        return None
    return draft.ClipSettings(**{key: spec[key] for key in keys if key in spec})


def add_clip(script: Any, spec: dict[str, Any]) -> None:
    """往草稿里加一个片段（视频/音频/文本）。"""
    kind = spec.get("kind")
    track = spec.get("track")
    start = parse_time(spec.get("start", 0))
    duration = parse_time(spec["duration"])
    target = draft.Timerange(start, duration)
    source = None
    if spec.get("sourceStart") is not None:
        source = draft.Timerange(parse_time(spec["sourceStart"]), duration)

    if kind in ("video", "image", "audio"):
        path = spec.get("path")
        if not path:
            fail(f"{kind} 片段缺少 path：{spec}")
        base: dict[str, Any] = {
            "target_timerange": target,
            "source_timerange": source,
            "speed": spec.get("speed"),
            "volume": spec.get("volume", 1.0),
        }
        if kind == "audio":
            # AudioSegment 没有 clip_settings 参数，多传会直接 TypeError。
            segment = draft.AudioSegment(draft.AudioMaterial(str(Path(path).expanduser())), **base)
        else:
            segment = draft.VideoSegment(
                draft.VideoMaterial(str(Path(path).expanduser())),
                **base,
                clip_settings=clip_settings(spec),
            )
    elif kind == "text":
        style = None
        if isinstance(spec.get("style"), dict):
            style = draft.TextStyle(**spec["style"])
        segment = draft.TextSegment(
            str(spec.get("text", "")), target,
            style=style,
            clip_settings=clip_settings(spec),
        )
    else:
        fail(f"不支持的片段类型：{kind!r}（只支持 video / image / audio / text）")

    if spec.get("fadeIn") is not None or spec.get("fadeOut") is not None:
        segment.add_fade(spec.get("fadeIn", 0), spec.get("fadeOut", 0))

    for key, method in (("intro", "add_animation"), ("outro", "add_animation"),
                        ("loop", "add_animation")):
        if spec.get(key):
            getattr(segment, method)(resolve_enum(str(spec[key])))

    if isinstance(spec.get("effect"), dict):
        effect = spec["effect"]
        segment.add_effect(resolve_enum(str(effect["name"])), effect.get("params"))
    if isinstance(spec.get("filter"), dict):
        entry = spec["filter"]
        segment.add_filter(resolve_enum(str(entry["name"])), entry.get("intensity"))

    for keyframe in spec.get("keyframes") or []:
        at = parse_time(keyframe["at"])
        value = keyframe["value"]
        if kind == "audio":
            segment.add_keyframe(at, value)
        else:
            segment.add_keyframe(getattr(draft.KeyframeProperty, str(keyframe["property"])), at, value)

    script.add_segment(segment, track)


def main() -> int:
    """入口。"""
    plan_path = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else work_dir() / "plan.json"
    plan = load_json(plan_path)
    if not isinstance(plan, dict):
        fail(f"{plan_path} 必须是一个 JSON 对象")
    if plan.get("approved") is not True:
        fail(f"{plan_path} 的 approved 不是 true —— 分镜要人确认过才允许构建")

    store = draft_store()
    folder = draft.DraftFolder(str(store))
    name = str(plan.get("draftName") or "").strip()
    if not name:
        fail("plan.json 缺少 draftName")

    template = str(plan.get("template") or "").strip()
    if template:
        script = folder.duplicate_as_template(template, name, allow_replace=True)
        ok(f"从模板「{template}」复制出草稿「{name}」")
    else:
        script = folder.create_draft(
            name,
            int(plan.get("width", 1920)),
            int(plan.get("height", 1080)),
            int(plan.get("fps", 30)),
            allow_replace=True,
        )
        ok(f"新建草稿「{name}」")

    for track in plan.get("tracks") or []:
        track_type = TRACK_TYPES.get(str(track.get("type")))
        if track_type is None:
            fail(f"未知轨道类型：{track.get('type')!r}")
        script.append_track(draft.TrackSpec(track_type, str(track.get("name") or "")))

    for index, spec in enumerate(plan.get("clips") or []):
        try:
            add_clip(script, spec)
        except SegmentOverlap:
            fail(
                f"第 {index + 1} 个片段与同轨道的已有片段重叠："
                f"track={spec.get('track')!r} kind={spec.get('kind')!r} start={spec.get('start')!r} "
                f"duration={spec.get('duration')!r}。同一条轨道上的片段不能有时间重叠 —— "
                f"错开时间，或把其中一个放到另一条同类型轨道上。"
            )

    subtitles = plan.get("subtitles")
    if isinstance(subtitles, dict) and subtitles.get("srt"):
        script.import_srt(
            str(Path(str(subtitles["srt"])).expanduser()),
            str(subtitles.get("track") or "字幕"),
            time_offset=subtitles.get("offset", 0.0),
        )
        ok(f"已导入字幕：{subtitles['srt']}")

    script.save()
    ok("草稿已保存。下一步：在剪映里打开它确认内容，然后跑 draft_review.py")
    ok(f"  草稿目录：{store / name}")
    ok(f"  登记用：draft_stage action=advance draft={name} draftStore={store}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
