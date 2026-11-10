# 任务单

任务：开书，并写第 1–{{count}} 章（共 {{count}} 章）
{{owner_line}}

这是一本新书。主人的种子在 seed.md（原样保留，可能为空）。{{resume}}

1. 先读 seed.md 和下面的书库摘要。想 3 个不同的方向，选和书库里已有的书最不像的那个，在 bible.md 里写一行"与《X》《Y》的区别"。
2. 写 bible.md：第一行"# 《书名》"，第二行"一句话：……"，第三行"标签：……"（3–6 个词）；然后写人物、世界、文风和结局方向。
3. 写 outline.md：全书骨架（写明结局）、一行"计划：共 N 章"（建议 {{planned}} 章，可以加到 {{planned_max}} 章）、前 {{count}} 章的细纲。
4. 建立笔记：notes/progress.md、notes/chapters.md、notes/cast.md、notes/threads.md（格式见 AGENTS.md）。
5. 然后连续写正文第 1–{{count}} 章：manuscript/c00001.md 起，每个文件第一行写"# 第N章 章名"，每章一次写成。
6. 这一批全部写完后，一次性更新笔记：notes/chapters.md 每章追加一行，整理 notes/cast.md、notes/threads.md，更新 notes/progress.md。
7. 全书不少于 {{target_cjk}} 字，每章不少于 {{min_chars}} 字，不设上限。故事远没到结尾，不要写"（全书完）"。

{{library}}
{{hints}}
省事的规矩：
- 不用自己统计字数，系统会统计；不要重读自己刚写的文件。
- 写的时候就注意：每章结尾是完整的句子；正文里没有"（本章完）"、创作说明或写给读者以外的话；少用重复的词、说明腔和设问式的结尾。
- bible.md 前三行按上面的格式写，notes/chapters.md 每章一行。
