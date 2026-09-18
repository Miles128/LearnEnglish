# word-details.json 数据来源与许可

本文件由 `node scripts/build-dict.mjs` 生成，合并以下两个开放数据源：

## ECDICT
- 仓库：https://github.com/skywind3000/ECDICT
- 许可：MIT
- 用途：多义中文释义、词性、柯林斯星级、牛津 3000/5000、BNC/COCA 词频、词形变化（lemma）
- 字段来源：`ecdict.csv`（word / phonetic / definition / translation / pos / collins / oxford / tag / bnc / frq / exchange）

## Tatoeba
- 站点：https://tatoeba.org  ·  下载：https://downloads.tatoeba.org/exports/
- 许可：CC BY 2.0 FR（部分句子 CC0 1.0）— 使用需署名
- 用途：英文例句 + 中文对照翻译（eng_sentences / cmn_sentences / eng-cmn_links）

如需重新生成，请保留上述署名信息。
