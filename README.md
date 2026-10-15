# dsh-active-sessions

左侧边栏「进行中」tab：跨项目平铺展示会话，点击即切换。

分组顺序（自上而下）：
1. **进行中** —— 运行中，或等待审批/计划审阅/回答的会话；
2. **已完成** —— 已停止但尚未读过（打开即清除未读）的会话；
3. **近 12h 活跃** —— 其余空闲会话，默认折叠（展开态记在 localStorage）。

tab 角标 = 进行中 + 已完成未读的数量，不含折叠的空闲会话。

由 dsh-super-injector dev_scaffold_plugin 生成。

## 构建与注入

```bash
bash scripts/build.sh
# 注入器环境内：dev_inject_plugin <本目录>
```
