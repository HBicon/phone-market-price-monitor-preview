# 行情数据存储

本目录只用于本地生产数据，不进入 Git 仓库。

- `raw/YYYY-MM-DD.xlsx`：Boss 报表 501211 的原始导出文件。
- `price_history.sqlite`：按日归一后的报价快照与批次质量记录。
- `real/`：基于真实数据生成的内部数据文件。

公开评审站只使用经过 `prepare_public_data.py` 脱敏后的 `assets/data.js`，不得直接发布本目录内容。
