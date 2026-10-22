# MediaGrab Logo 生成提示词

## 设计目标

为跨平台桌面媒体下载与解析应用 **MediaGrab** 设计一套简洁、现代、专业的品牌 Logo。产品支持 B 站、抖音、小红书等平台的视频下载、媒体解析和音频提取，后续会扩展更多来源。Logo 需要同时适合 macOS Dock、Windows 开始菜单、Linux 应用菜单、桌面应用窗口左上角以及深色 UI 侧栏。

## 中文主提示词

```text
为跨平台桌面应用“MediaGrab”设计一个简洁、现代的应用 Logo，主题是“多条媒体内容被抓取、整理并收集到一起”。核心图形是用一个装订环串起来的三张长条圆角卡片，像一组展开的书签。后方卡片使用播放三角形表达视频，中间卡片使用简洁音符表达音频，前方卡片使用极简图片缩略图符号表达图片。每张卡片只有一个居中符号，三个符号使用同一紫色，保持接近的视觉重量。

三张卡片宽高比约为 2.53:1，比薄条更饱满。圆角参考苹果卡片的连续曲率观感，从直边逐渐过渡到弯角，避免突兀的圆弧接头；保留横向直边，不要成为胶囊。后卡、中卡、前卡分别以约 -24°、0°、+24° 扇形展开，同时拉开卡片中心的纵向距离。重叠主要发生在卡片左端，三个居中图标必须完整露出，不能被其他卡片或阴影盖住。每张卡片左端都有一个带浅色孔沿的空心圆孔，使用同一条细小的浅蓝色椭圆连接环依次穿过三个圆孔，形成真实的书签束装订关系。连接环只出现在左侧重叠区域，不要包围整个图标。

应用图标采用圆角方形紫蓝渐变底面，四角外侧透明。三张卡片依次使用浅紫、淡蓝和近白色不透明底面，用色差和轻微阴影区分层次，不让后方图标透过前卡。构图居中、安全边距充足。不要添加第二层圆角底板、装饰圆点、光晕、文字、元数据短线或复杂材质。缩小后优先保留三张卡片的扇形轮廓和媒体符号，不依赖圆环细节才能识别。

品牌气质：可靠、快速、克制、专业、跨平台、媒体工作台。视觉风格参考高品质生产力软件图标，不要做成视频网站 Logo，不要出现具体平台的品牌标志，不要使用 B 站、抖音、小红书的 Logo，不要出现复杂场景或人物。

输出一个正方形应用图标，圆角底板四周保留约 4% 到 6% 的透明安全边距。输出 SVG 或至少 1024×1024 的 PNG，适合后续生成桌面应用图标。
```

## 负面提示词

```text
不要文字，不要字母 M，不要产品名称，不要英文单词，不要水印，不要具体平台 Logo，不要人物，不要手，不要鼠标，不要手机模型，不要浏览器窗口，不要音频波形，不要下载箭头，不要单张居中的大卡片，不要复杂背景，不要照片质感，不要 3D 金属材质，不要过度发光，不要霓虹灯污染，不要彩虹色，不要橙色和棕色主色，不要黑色描边，不要深色外框，不要黑边，不要卡片彼此完全遮挡，不要播放符号变形或粘连，不要尖锐刺眼的高光，不要细碎装饰，不要复杂线条，不要低对比度，不要裁切，不要不对称失衡，不要生成多个图标，不要带边框的展示样机，不要海报排版。
```

## GPT-Image-2 生成提示词

首次生成只复制下面的英文主提示词即可，构图、圆孔串联与负面约束都已包含。选定结果后检查透明边缘和缩小效果；干净的 PNG 可以直接用于应用图标，需要精确调整几何结构时再用 SVG 重绘。

### 主提示词

```text
Design an original, minimal, premium app icon for a cross-platform desktop media tool named MediaGrab. The symbol should communicate media collection and grabbing without using any text, letters, words, watermark, literal download arrow, or platform-specific logo. Do not render the product name inside the image.

Use exactly three substantial horizontal rounded-rectangle media cards, each approximately 2.53 times as wide as it is tall. Use soft Apple-inspired continuous corners with gradual transitions from straight edges into curved corners; retain long straight horizontal edges rather than making capsules. Give the upper rear card one centered video play triangle, the middle card one centered musical note, and the lower front card one centered minimal image-thumbnail glyph. Use the same deep violet for all three symbols and balance their visual weight. Fan the cards out at approximately -24 degrees, 0 degrees, and +24 degrees. Separate the card centers vertically so that every media symbol is completely visible, including its entire outline. Let the cards overlap mainly at their left ends; do not overlap their central symbols.

Give each card exactly one small hollow circular punched hole near its left end, with a pale rim and a darker visible opening. Thread one slender pale-blue oval binding ring through all three holes, like a bound set of bookmarks or a small swatch book. Keep the ring confined to the left overlap area, clearly separate from the three media symbols. The holes are part of the binding, not floating decorative dots. Do not use a large surrounding ring, chain links, or a second frame.

Place the symbol on one rounded-square violet-to-indigo-to-blue gradient tile. Use opaque pale lavender, pale blue, and near-white card surfaces, with restrained soft shadows to show the layering. Do not show rear symbols through the front cards. Keep the silhouette bold, geometric, calm, and professional, with clean edges and generous margins. Do not add text, metadata lines, audio waveforms, a crop frame, hands, a mouse, a phone, a browser window, extra cards, decorative particles, neon glow, glossy 3D material, a black outline, a second background tile, a mockup, or a presentation board.

Output one centered square icon only, 1024x1024 or larger. Keep the rounded-square tile opaque and the canvas outside its rounded corners transparent, leaving about 4 to 6 percent canvas margin around the tile. No simulated checkerboard, edge noise, cropped elements, or multiple variations in the same image.
```

### 迭代提示词

```text
Keep exactly three media cards, the violet-blue palette, and fan angles of approximately -24 degrees, 0 degrees, and +24 degrees. Make the cards fuller, with a width-to-height ratio of about 2.53:1, and use Apple-inspired continuous corners instead of simple circular arcs. Move the centers apart vertically until the centered video, audio, and image glyphs are all completely unobstructed. Keep overlap near the left ends. Preserve one hollow punched hole per card and one slender pale-blue binding ring threaded through the three holes, like bound bookmarks. Keep all glyphs the same deep violet and all card surfaces opaque. Remove text, metadata lines, floating dots, extra rings, heavy gloss, edge noise, and any second background tile.
```

### 生成后检查

- 先检查原图中三个居中符号是否完整露出，再检查 64px、32px 和 16px 下的扇形轮廓与符号清晰度。
- 检查三张卡片是否真的有前后层次，而不是融合成一条厚横线。
- 检查三个空心圆孔与同一条连接环是否形成串联关系，圆环不能遮挡卡片中间的图标。
- 检查是否出现随机文字、错误字母、额外图标或类似下载箭头的形状。
- 选定方向后使用干净的 PNG 或矢量源文件，重新生成 `apps/desktop/src-tauri/icons` 下的全套桌面图标。

## 推荐变体

可以基于主提示词分别生成以下三组方向，再选择一组继续迭代：

1. **串联书签版（当前方案）**：视频、音频和图片卡片扇形展开，左侧空心圆孔用一个连接环串起。
2. **紧凑串联版**：保留圆孔与连接环，减小卡片展开范围，但三个居中符号仍须完整可见。
3. **无环堆叠版**：保留三种媒体符号和扇形结构，省略圆孔与连接环，供比较轮廓简洁度。

## 后处理要求

- 优先选择透明背景、正方形构图、单独主体的结果。
- 删除生成结果中的任何文字、平台标识、样机边框和背景纹理。
- 确保深色背景 `#101014` 和浅色背景上都清晰可见。
- 生成桌面图标前，保留一份原始透明 PNG，至少 `1024×1024`。
- 生成网页 Logo 时可以保留渐变；系统图标中三个媒体符号均不得被其他卡片遮挡。缩小后优先保留卡片和符号，连接环只提供辅助识别。
- 应用侧栏建议使用 `32×32` 或 `40×40`；窗口图标和安装包图标使用 `512×512` 或更高分辨率。

## 当前仓库实现

仓库已内置一版不依赖外部图片的矢量 Logo：

- `apps/web/src/assets/mediagrab-logo.svg`
- `apps/desktop/src-tauri/icons/icon.png`

当前实现使用“三张扇形媒体书签 + 左侧圆孔连接环”的图形语义：视频、音频和图片符号表达 media，串联书签表达内容被 grab / collect 到一起。三张卡片尺寸均为 304×120，中心分别位于 (266, 153)、(266, 256)、(266, 359)，角度为 -24°、0°、+24°。卡片共用一个以三次贝塞尔曲线绘制的轮廓，近似连续圆角的视觉效果；这不是苹果系统圆角的精确复刻。圆孔位于左侧重叠区域，中心图标完整露出。桌面端图标由同一个 SVG 批量生成。

在仓库根目录执行：

```sh
pnpm --dir apps/desktop exec tauri icon ../web/src/assets/mediagrab-logo.svg --output src-tauri/icons
```
