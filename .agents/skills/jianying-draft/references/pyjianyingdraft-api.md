# pyJianYingDraft API 速查

按需查阅。日常流程用 `scripts/draft_build.py` 就够，这份是它的能力边界与原始 API。

安装：`pip install pyJianYingDraft`（本机装的是 0.3.0）。时间单位一律**微秒**，
`draft.SEC == 1000000`；字符串写法（`"1.5s"`、`"1h3m12s"`）用 `draft.tim()` 转。

## 草稿与轨道

```python
import pyJianYingDraft as draft

folder = draft.DraftFolder("<剪映草稿文件夹>")        # 形如 .../JianyingPro Drafts
script = folder.create_draft("名字", 1920, 1080, fps=30, allow_replace=True)
script = folder.duplicate_as_template("模板草稿名", "新草稿名", allow_replace=True)
script = folder.load_template("草稿名")               # 读已有草稿（新版剪映可能非明文）

script.append_track(draft.TrackSpec(draft.TrackType.video, "主轨"))
script.insert_track(draft.TrackSpec(draft.TrackType.text), over_track=ref)  # 插到某轨之上
ref = script.append_track(...)                        # 返回 TrackRef，可用于定位
script.save()
```

`TrackType`：`video` / `audio` / `text` / `sticker` / `effect` / `filter` / `adjust`。

## 片段

```python
seg = draft.VideoSegment(path, target_timerange, source_timerange=None,
                         speed=None, volume=1.0, change_pitch=False, clip_settings=None)
seg = draft.AudioSegment(path, target_timerange, ...)          # 参数同上
seg = draft.TextSegment(text, timerange, font=None, style=None,
                        clip_settings=None, border=None, background=None, shadow=None)

script.add_segment(seg, "轨道名")     # 轨道名可省，前提是该类型只有一条轨道
```

- `target_timerange` 是**在时间轴上的位置与时长**；`source_timerange` 是**从素材里截哪一段**。
- 给了 `source_timerange` 而没给 `speed` 时，速度按「素材片段长 ÷ 目标时长」自动算。
- 同时给 `source_timerange` 与 `speed` 时，`target_timerange` 的时长被 `speed` 覆盖。

## 片段上的效果

```python
seg.add_fade("1s", "2s")                              # 淡入、淡出（每个片段只能调一次）
seg.add_animation(draft.TextIntro.复古打字机)
seg.add_effect(draft.VideoSceneEffectType.全息扫描, [None, None, 100.0])   # 参数顺序见枚举注释
seg.add_filter(draft.FilterType.原生肤, 10)            # 强度
seg.add_mask(draft.MaskType.线性, center_x=100, rotation=45)
seg.add_chroma(color="#E2ECD0FF", intensity=20, shadow=0, edge_smooth=0, spill=0)
seg.set_mix_mode(draft.MixModeType.滤色)               # 需要至少两条视频轨道
seg.add_keyframe(draft.KeyframeProperty.alpha, time, value)
audio_seg.add_keyframe(time, volume)                   # 音频只支持音量关键帧
```

`KeyframeProperty`：`alpha` / `brightness` / `contrast` / `position_x` / `position_y` /
`rotation` / `saturation` / `scale_x` / `scale_y` / `uniform_scale` / `volume`。
关键帧吸附在**片段**上，时刻相对片段头部。

文本片段只支持位置与大小相关属性；同时要循环动画和出入场动画时，**先出入场、后循环**。

## 轨道级特效与滤镜

```python
script.append_track(draft.TrackSpec(draft.TrackType.effect, "my_effect"))
script.add_effect(draft.VideoSceneEffectType.胶片闪切, trange_seconds(0, duration=5),
                  track_name="my_effect", params=[50, None, 80])
script.add_filter(draft.FilterType.哈苏蓝, trange(0, script.duration), intensity=70)
```

## 字幕

```python
script.import_srt("subtitle.srt", track_name="字幕", time_offset="1.5s")
script.import_srt("x.srt", track_name="字幕", text_style=draft.TextStyle(size=10.0, color=(1.0, 0.0, 0.0)))
script.import_srt("x.srt", track_name="字幕", style_reference=some_text_segment)   # 以某个文本片段为样式参考
```

只认 **SRT**。默认启用自动换行；`TextStyle(auto_wrapping=True, max_line_width=0.7)` 可调。

## 样式与变换

```python
draft.TextStyle(size=5.0, color=(0.7, 0.7, 1.0), underline=True, align=1,
                auto_wrapping=True, max_line_width=0.7)
draft.ClipSettings(alpha=0.5, flip_horizontal=True, transform_y=-0.8)
draft.FontType.文轩体
```

## 按名字找特效/动画/滤镜

枚举成员基本以中文名命名，且都支持 `from_name`（忽略大小写、空格、下划线）：

```python
draft.VideoSceneEffectType.from_name("__全息 扫描__") == draft.VideoSceneEffectType.全息扫描
```

可用的枚举类：`IntroType` / `OutroType` / `GroupAnimationType`（视频动画）、
`TextIntro` / `TextOutro` / `TextLoopAnim`（文本动画）、
`VideoSceneEffectType` / `VideoCharacterEffectType`（画面/人物特效）、
`FilterType`（滤镜）、`AudioSceneEffectType` / `ToneEffectType`（音频场景音/音色）、
`MaskType` / `MixModeType`。

## 模板模式

```python
script = folder.duplicate_as_template("模板", "新草稿")
script.replace_material_by_name("audio.mp3", draft.AudioMaterial("新的.mp3"))   # 按素材名替换
script.replace_material_by_seg(audio_track, 0, new_material,
                               source_timerange=trange_seconds(0, duration=10),
                               handle_shrink=draft.ShrinkMode.cut_tail,
                               handle_extend=draft.ExtendMode.push_tail)
script.replace_text(text_track, 0, "新文本")             # 保留格式、只换内容
script.import_track(source_script, text_track, offset=script.duration, new_name="imported")
script.inspect_material()                               # 提取贴纸/气泡/花字的 resource_id
```

导入的轨道与新建轨道相互隔离：**不能在导入的轨道上加片段**，但可以照常新建轨道。

## 批量导出（仅 Windows + 剪映 6 及以下）

```python
from pyJianYingDraft import ExportResolution, ExportFramerate
ctrl = draft.JianyingController()        # 需要剪映已打开并停在目录页
ctrl.export_draft("草稿名", "<导出路径>",
                  resolution=ExportResolution.RES_1080P, framerate=ExportFramerate.FR_24)
```

依赖 `uiautomation`（Windows 专有），会把剪映窗口置顶并模拟点击，**建议闲时运行**。
Python 3.13 下该库有已知依赖问题。

## 已知边界

- **剪映 7+ 隐藏了导出控件**，自动导出失效；**Linux/macOS 完全不支持自动导出**，
  生成的草稿仍需在剪映里人工导出。
- **剪映 6.0+ 的 `draft_content.json` 可能是加密的**，模板读取需要额外的
  `DraftFolder(..., fallback_loader=...)`。
- 未缓存的动画/特效/转场在剪映打开草稿时会尝试下载，可能超时并显示「xx 加载失败」。
- 未缓存的字体需要**二次打开草稿**才生效。
- 不支持曲线变速。
