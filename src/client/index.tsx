/**
 * dsh-active-sessions — client 半区（浏览器侧）。
 *
 * 在左侧边栏会话浏览区（ui-sidebar 的 regionArea）顶部注入一个
 * 「工作区 / 进行中」切换 tab：
 *  - 工作区：官方按项目分组的会话树（原样保留）；
 *  - 进行中：分三段展示，点击任意行即切换（官方导航 ctx.uiWorkspace.openSession，
 *    内部走 sessions.retain(mainView)）：
 *      ① 进行中 —— running 或等待审批/计划审阅/回答；
 *      ② 已完成 —— 跑完但尚未读过（uiSession.sessionStatus.completionUnread）；
 *      ③ 近 12h 活跃 —— 其余空闲会话，默认折叠在底部（展开态持久化到 localStorage）。
 *    tab 角标只计顶部需要关注的数量（①+②）；已归档会话（workspaces.list
 *    快照的 archivedSessionIds）与官方工作区树一致，不进入任何分组。
 *
 * 实现方式与 better-sidebar / side-chat 同路线：外来 DOM 子节点 + 独立
 * React root，不改官方组件；MutationObserver 守卫重挂载；折叠态自动隐藏。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'

/* ------------------------------------------------------------------ */
/* 结构类型：第三方插件拿不到上游 cordis 模块扩充，按运行时真实形状声明 */
/* ------------------------------------------------------------------ */

/** 与 @deepseek-ai/dsh-api-session-controller 的 SessionSummary 对齐。 */
interface SessionRow {
  id: string
  displayTitle: string
  running: boolean
  blank: boolean
  updatedAt: number
  cwd?: string
  title?: string
  parentId?: string
  origin?: 'subagent'
  /** 本地引用计数；主视图当前会话 = retainedBy.mainView > 0。 */
  retainedBy?: Readonly<Partial<Record<string, number>>>
}

/** 与 SessionListState 对齐：没有 current 字段，当前会话由 retainedBy.mainView 判定。 */
interface ListSnapshot {
  ids: string[]
  byId: Record<string, SessionRow>
}

interface Store<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface SessionsService {
  list: Store<ListSnapshot>
  /** 旧假设的 API；真实 Controller 没有 open，仅作兼容 fallback。 */
  open?(sessionId: string): void
}

interface LocaleService {
  getSnapshot(): { active: string }
  subscribe?(listener: () => void): () => void
}

/** uiSession.sessionStatus 的行状态（SessionStatus）。 */
interface SessionStatus {
  running?: boolean
  pendingInteraction?: { key: string; kind: string; sessionId: string }
  completionUnread?: boolean
}

/** dsh-client-ui-session 的 UiSession 服务真实形状。 */
interface UiSessionService {
  sessionStatus: Store<ReadonlyMap<string, SessionStatus>>
}

/** dsh-client-ui-workspace 的导航服务：openSession 是官方切换会话入口。 */
interface UiWorkspaceService {
  openSession(target: string): void
}

/** dsh-api-workspace-controller 的 WorkspaceSnapshot（只取本插件用到的字段）。 */
interface WorkspaceSnapshotMinimal {
  /** Host 确认的全局归档会话集合；归档会话不在本面板展示。 */
  archivedSessionIds?: readonly string[]
}

interface WorkspacesService {
  list: Store<WorkspaceSnapshotMinimal>
}

interface ClientContext {
  sessions: SessionsService
  locale: LocaleService
  uiSession?: UiSessionService
  uiWorkspace?: UiWorkspaceService
  effect(setup: () => void | (() => void), label?: string): () => void
}

/**
 * cordis 服务注入声明：sessions（会话列表）、locale（中英词典）、
 * uiSession（运行/等待交互状态）、uiWorkspace（openSession 官方导航）、
 * workspaces（归档集合 archivedSessionIds，用于隐藏已归档会话）。
 * 未声明的服务在插件 ctx 上不可见，懒轮询也拿不到——必须在此声明。
 */
export const inject = ['sessions', 'locale', 'uiSession', 'uiWorkspace', 'workspaces']

/* ------------------------------------------------------------------ */
/* 词典                                                                */
/* ------------------------------------------------------------------ */

type Lang = 'zh' | 'en'

const DICT: Record<Lang, Record<string, string>> = {
  zh: {
    'tab.workspace': '工作区',
    'tab.active': '进行中',
    'tab.active.aria': '进行中或已完成未读的会话（{n} 个）',
    'empty': '近 12 小时没有活跃会话',
    'section.active': '进行中',
    'section.done': '已完成',
    'section.idle': '近 12h 活跃',
    'section.expand': '展开「{label}」（{n} 个）',
    'section.collapse': '折叠「{label}」（{n} 个）',
    'status.done': '已完成',
    'status.running': '进行中',
    'status.waitingApproval': '等待审批',
    'status.planReview': '计划待审',
    'status.waitingAnswer': '等待回答',
    'status.waiting': '等待交互',
    'status.idle': '空闲',
    'current': '当前',
    'time.now': '刚刚',
    'time.minutes': '{n}分钟前',
    'time.hours': '{n}小时前',
    'time.days': '{n}天前',
    'row.aria': '切换到会话 {title}',
  },
  en: {
    'tab.workspace': 'Workspaces',
    'tab.active': 'Active',
    'tab.active.aria': 'Running or unread completed sessions ({n})',
    'empty': 'No sessions active in the last 12 hours',
    'section.active': 'Running',
    'section.done': 'Completed',
    'section.idle': 'Active in last 12h',
    'section.expand': 'Expand {label} ({n})',
    'section.collapse': 'Collapse {label} ({n})',
    'status.done': 'Completed',
    'status.running': 'Running',
    'status.waitingApproval': 'Waiting for approval',
    'status.planReview': 'Plan awaiting review',
    'status.waitingAnswer': 'Waiting for answer',
    'status.waiting': 'Waiting for input',
    'status.idle': 'Idle',
    'current': 'current',
    'time.now': 'now',
    'time.minutes': '{n}m ago',
    'time.hours': '{n}h ago',
    'time.days': '{n}d ago',
    'row.aria': 'Switch to session {title}',
  },
}

type TFn = (key: string, vars?: Record<string, string | number>) => string

function makeT(lang: Lang) {
  return (key: string, vars?: Record<string, string | number>): string => {
    let s = DICT[lang][key] ?? DICT.zh[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v))
    return s
  }
}

/* ------------------------------------------------------------------ */
/* 样式（官方 sidebar 同一套 CSS 变量，暗色主题自适应）                */
/* ------------------------------------------------------------------ */

const CSS = `
[data-dsh-active-sessions]{display:flex;flex-direction:column;min-height:0;font-size:13px}
[class*="regionArea"][data-dsh-as-tab="workspace"]>[data-dsh-active-sessions]{flex:0 0 auto}
[class*="regionArea"][data-dsh-as-tab="active"]>[data-dsh-active-sessions]{flex:1 1 auto;min-height:0}
[class*="regionArea"][data-dsh-as-tab="active"]>*:not([data-dsh-active-sessions]){display:none!important}
[data-dsh-as-collapsed="1"] [data-dsh-active-sessions]{display:none!important}
.dsh-as-strip{display:flex;align-items:center;gap:2px;flex:none;padding:2px;margin:0 2px 6px}
.dsh-as-tab{display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;padding:3px 10px;border-radius:8px;
  font-family:inherit;transition:background .12s var(--ds-ease-in-out,ease)}
.dsh-as-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-as-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);font-weight:500}
.dsh-as-count{min-width:16px;height:16px;padding:0 4px;border-radius:8px;font-size:10px;font-weight:600;
  line-height:16px;text-align:center;color:var(--dsw-specific-sidebar-fill,#fff);background:var(--dsw-alias-label-primary)}
.dsh-as-list{flex:1 1 auto;overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:2px;padding:0 2px 8px}
.dsh-as-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 8px;border-radius:10px;
  border:1px solid transparent;background:transparent;cursor:pointer;color:inherit;font-family:inherit;
  transition:background .12s var(--ds-ease-in-out,ease)}
.dsh-as-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-as-row[data-current="1"]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dsh-as-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#9a9a9a)}
.dsh-as-dot[data-state="run"]{background:#22c55e;animation:dsh-as-pulse 1.6s var(--ds-ease-in-out,ease) infinite}
.dsh-as-dot[data-state="warn"]{background:#f59e0b}
.dsh-as-dot[data-state="done"]{background:#22c55e}
@keyframes dsh-as-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dsh-as-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsh-as-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-as-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-as-status{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:8px;
  color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l3)}
.dsh-as-status[data-warn="1"]{color:#f59e0b;border-color:#f59e0b55}
.dsh-as-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-as-section{display:flex;flex-direction:column;gap:2px}
.dsh-as-section+.dsh-as-section{margin-top:6px}
.dsh-as-sec-head{display:flex;align-items:center;gap:6px;width:100%;margin:0;padding:5px 8px 3px;border:none;
  background:transparent;font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.02em;
  color:var(--dsw-alias-label-secondary);text-align:left;cursor:default}
button.dsh-as-sec-head{cursor:pointer;border-radius:8px;transition:background .12s var(--ds-ease-in-out,ease)}
button.dsh-as-sec-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
button.dsh-as-sec-head:focus-visible{outline:1px solid var(--dsw-alias-border-l3);outline-offset:-1px}
.dsh-as-sec-label{flex:none}
.dsh-as-sec-count{min-width:14px;height:14px;padding:0 4px;border-radius:7px;font-size:10px;font-weight:600;
  line-height:14px;text-align:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-as-chev{flex:none;width:9px;font-size:8px;line-height:9px;color:var(--dsw-alias-label-tertiary,#9a9a9a);
  transition:transform .12s var(--ds-ease-in-out,ease)}
.dsh-as-chev[data-open="1"]{transform:rotate(90deg)}
.dsh-as-row[data-unread="1"] .dsh-as-title{font-weight:600}
.dsh-as-status[data-done="1"]{color:#22c55e;border-color:#22c55e66}
@media (prefers-reduced-motion:reduce){.dsh-as-dot{animation:none}.dsh-as-chev{transition:none}}
`

const CSS_TAG_ID = 'dsh-active-sessions/client.css'

function injectCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-active-sessions'
  tag.dataset.pluginCss = CSS_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

function removeCss(): void {
  document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']')?.remove()
}

/* ------------------------------------------------------------------ */
/* 数据推导                                                            */
/* ------------------------------------------------------------------ */

const EMPTY_STATUS: ReadonlyMap<string, SessionStatus> = new Map()
const EMPTY_WORKSPACE: WorkspaceSnapshotMinimal = {}

type PendingKind = 'approval' | 'plan-review' | 'question' | 'other'

/**
 * pendingInteraction.kind 是各 UI 域自有的判别串（approval/plan/question 等域
 * 各自注册），做宽松归类；任何非空 pendingInteraction 都视为等待交互。
 */
function visiblePendingKind(kind: string | undefined): PendingKind | undefined {
  if (kind === undefined || kind === '') return undefined
  const k = kind.toLowerCase()
  if (k.includes('approv')) return 'approval'
  if (k.includes('plan')) return 'plan-review'
  if (k.includes('question') || k.includes('answer') || k.includes('ask')) return 'question'
  return 'other'
}

type Bucket = 'active' | 'done' | 'idle'

interface ActiveRow {
  id: string
  displayTitle: string
  cwd?: string
  updatedAt: number
  current: boolean
  running: boolean
  pending?: PendingKind
  /** 运行结束但尚未在主视图里读过（官方 completionUnread，打开会话即自动清除）。 */
  unread: boolean
}

interface GroupedRows {
  /** 进行中：运行中或等待交互（审批/计划/回答）。 */
  active: ActiveRow[]
  /** 已完成未读：跑完还没看过的收尾会话。 */
  done: ActiveRow[]
  /** 近 12h 活跃：其余空闲会话，默认折叠在底部。 */
  idle: ActiveRow[]
}

/** 活跃窗口：近 12 小时内有活动的空闲会话可见（运行中/等待交互/已完成未读不受窗口限制）。 */
const ACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000

/** 同组内按新鲜度排序：最近活动在前。 */
function byRecency(a: ActiveRow, b: ActiveRow): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : 1
}

/**
 * 分桶规则：
 *  - 进行中：running 或存在 pendingInteraction（不受 12h 窗口限制）；
 *  - 已完成：已停止但未被主视图读过（completionUnread，不受 12h 窗口限制）；
 *  - 近 12h 活跃：其余空闲会话，仅保留 updatedAt 在窗口内的。
 */
function computeGroups(
  list: ListSnapshot,
  status: ReadonlyMap<string, SessionStatus>,
  now: number,
  archived: ReadonlySet<string>,
): GroupedRows {
  const cutoff = now - ACTIVE_WINDOW_MS
  const groups: GroupedRows = { active: [], done: [], idle: [] }
  for (const id of list.ids) {
    const s = list.byId[id]
    if (s === undefined || s.origin === 'subagent' || s.blank) continue
    /* 与官方工作区树一致：已归档会话不进入任何分组 */
    if (archived.has(id)) continue
    const st = status.get(id)
    const kind = visiblePendingKind(st?.pendingInteraction?.kind)
    const running = s.running || st?.running === true
    const unread = st?.completionUnread === true
    const bucket: Bucket | undefined =
      running || kind !== undefined
        ? 'active'
        : unread
          ? 'done'
          : s.updatedAt >= cutoff
            ? 'idle'
            : undefined
    if (bucket === undefined) continue
    groups[bucket].push({
      id,
      displayTitle: s.displayTitle !== '' ? s.displayTitle : (s.title ?? id),
      ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
      updatedAt: s.updatedAt,
      /* 官方判定：主视图 retain 计数 > 0 即当前会话（SessionListState 无 current 字段） */
      current: (s.retainedBy?.mainView ?? 0) > 0,
      running,
      unread,
      ...(kind === undefined ? {} : { pending: kind }),
    })
  }
  groups.active.sort(byRecency)
  groups.done.sort(byRecency)
  groups.idle.sort(byRecency)
  return groups
}

function workspaceLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  const parts = cwd.split(/[\\/]+/).filter((p) => p !== '')
  const base = parts.length > 0 ? parts[parts.length - 1] : cwd
  return base
}

function relativeTime(ts: number, now: number, t: ReturnType<typeof makeT>): string {
  if (!ts || ts <= 0) return ''
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('time.now')
  if (minutes < 60) return t('time.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hours', { n: hours })
  return t('time.days', { n: Math.floor(hours / 24) })
}

/* ------------------------------------------------------------------ */
/* React 组件                                                          */
/* ------------------------------------------------------------------ */

function useStoreValue<T>(store: Store<T> | undefined, fallback: T): T {
  const getSnapshot = useCallback(() => (store === undefined ? fallback : store.getSnapshot()), [store, fallback])
  const subscribe = useCallback(
    (listener: () => void) => (store === undefined ? () => {} : store.subscribe(listener)),
    [store],
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/**
 * 服务延迟解析：与本插件 apply 顺序无约束，轮询几次即可拿到。
 * 注意：cordis ctx 对未注册服务的属性访问可能抛错，全部 try/catch。
 */
function useLazyService<T>(ctx: ClientContext, name: string): T | undefined {
  const [svc, setSvc] = useState<T | undefined>(() => {
    try {
      const found = (ctx as unknown as Record<string, unknown>)[name] as T | undefined
      return found ?? undefined
    } catch {
      return undefined
    }
  })
  useEffect(() => {
    if (svc !== undefined) return
    let tries = 0
    const id = setInterval(() => {
      tries += 1
      try {
        const found = (ctx as unknown as Record<string, unknown>)[name] as T | undefined
        if (found !== undefined && found !== null) {
          setSvc(found)
          clearInterval(id)
          return
        }
      } catch { /* 服务尚未注册 */ }
      if (tries >= 150) clearInterval(id)
    }, 200)
    return () => clearInterval(id)
  }, [ctx, name, svc])
  return svc
}

interface RowProps {
  row: ActiveRow
  now: number
  t: TFn
  onOpen: (id: string) => void
}

/** 单条会话行：状态点 + 标题/副标题 + 状态徽标。 */
function RowView({ row, now, t, onOpen }: RowProps) {
  const ws = workspaceLabel(row.cwd)
  const time = relativeTime(row.updatedAt, now, t)
  const subParts = [ws, time, row.current ? t('current') : ''].filter((p) => p !== '')
  /* 已完成未读：跑完、无人等待、且非当前主视图 */
  const doneUnread = row.unread && !row.running && row.pending === undefined
  const statusKey =
    row.pending === 'approval'
      ? 'status.waitingApproval'
      : row.pending === 'plan-review'
        ? 'status.planReview'
        : row.pending === 'question'
          ? 'status.waitingAnswer'
          : row.pending !== undefined
            ? 'status.waiting'
            : row.running
              ? 'status.running'
              : doneUnread
                ? 'status.done'
                : 'status.idle'
  const dotState = row.pending !== undefined ? 'warn' : row.running ? 'run' : doneUnread ? 'done' : 'idle'
  return (
    <button
      type="button"
      className="dsh-as-row"
      data-current={row.current ? '1' : '0'}
      data-unread={doneUnread ? '1' : '0'}
      aria-label={t('row.aria', { title: row.displayTitle })}
      onClick={() => onOpen(row.id)}
    >
      <span className="dsh-as-dot" data-state={dotState} />
      <span className="dsh-as-main">
        <span className="dsh-as-title">{row.displayTitle}</span>
        <span className="dsh-as-sub">{subParts.join(' · ')}</span>
      </span>
      <span className="dsh-as-status" data-warn={row.pending !== undefined ? '1' : '0'} data-done={doneUnread ? '1' : '0'}>
        {t(statusKey)}
      </span>
    </button>
  )
}

interface SectionProps {
  label: string
  rows: ActiveRow[]
  now: number
  t: TFn
  onOpen: (id: string) => void
  /** 传入 onToggle 即为可折叠分组；缺省表示常显（进行中 / 已完成）。 */
  open?: boolean
  onToggle?: (() => void) | undefined
}

/** 分组：可折叠的「近 12h 活跃」与常显的「进行中 / 已完成」共用同一渲染。 */
function Section({ label, rows, now, t, onOpen, open, onToggle }: SectionProps) {
  const collapsible = onToggle !== undefined
  const expanded = collapsible ? open === true : true
  const head = (
    <>
      {collapsible && (
        <span className="dsh-as-chev" data-open={expanded ? '1' : '0'} aria-hidden="true">
          {'\u25B6'}
        </span>
      )}
      <span className="dsh-as-sec-label">{label}</span>
      <span className="dsh-as-sec-count">{rows.length}</span>
    </>
  )
  return (
    <div className="dsh-as-section">
      {collapsible ? (
        <button
          type="button"
          className="dsh-as-sec-head"
          aria-expanded={expanded}
          aria-label={t(expanded ? 'section.collapse' : 'section.expand', { label, n: rows.length })}
          onClick={() => onToggle?.()}
        >
          {head}
        </button>
      ) : (
        <div className="dsh-as-sec-head">{head}</div>
      )}
      {expanded && rows.map((row) => <RowView key={row.id} row={row} now={now} t={t} onOpen={onOpen} />)}
    </div>
  )
}

interface AppProps {
  ctx: ClientContext
  region: HTMLElement
}

const TAB_KEY = 'dsh-active-sessions.tab'
/** 底部「近 12h 活跃」分组的展开态（默认折叠）。 */
const IDLE_OPEN_KEY = 'dsh-active-sessions.idleOpen'
type Tab = 'workspace' | 'active'

function SidebarTabsApp({ ctx, region }: AppProps) {
  const [tab, setTabState] = useState<Tab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'active' ? 'active' : 'workspace'
    } catch {
      return 'workspace'
    }
  })
  const setTab = useCallback((next: Tab) => {
    setTabState(next)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch { /* 隐私模式等场景忽略 */ }
  }, [])

  const sessionsRef = useRef(ctx.sessions)
  const listStore = useMemo<Store<ListSnapshot>>(
    () => ({
      getSnapshot: () => sessionsRef.current.list.getSnapshot(),
      subscribe: (l) => sessionsRef.current.list.subscribe(l),
    }),
    [],
  )
  const list = useSyncExternalStore(listStore.subscribe, listStore.getSnapshot)

  const uiSession = useLazyService<UiSessionService>(ctx, 'uiSession')
  const statusStore = useMemo<Store<ReadonlyMap<string, SessionStatus>> | undefined>(
    () => (uiSession === undefined ? undefined : {
      getSnapshot: () => uiSession.sessionStatus.getSnapshot(),
      subscribe: (l) => uiSession.sessionStatus.subscribe(l),
    }),
    [uiSession],
  )
  const status = useStoreValue(statusStore, EMPTY_STATUS)

  /* 归档集合：workspaces.list 快照里的 archivedSessionIds（延迟解析，服务缺席时不过滤） */
  const workspaces = useLazyService<WorkspacesService>(ctx, 'workspaces')
  const wsStore = useMemo<Store<WorkspaceSnapshotMinimal> | undefined>(
    () => (workspaces === undefined ? undefined : {
      getSnapshot: () => workspaces.list.getSnapshot(),
      subscribe: (l) => workspaces.list.subscribe(l),
    }),
    [workspaces],
  )
  const wsSnapshot = useStoreValue(wsStore, EMPTY_WORKSPACE)
  const archived = useMemo(
    () => new Set<string>(wsSnapshot.archivedSessionIds ?? []),
    [wsSnapshot],
  )

  /* 官方切换会话入口：uiWorkspace.openSession（延迟解析，见 useLazyService） */
  const uiWorkspace = useLazyService<UiWorkspaceService>(ctx, 'uiWorkspace')
  const uiWorkspaceRef = useRef(uiWorkspace)
  useEffect(() => {
    uiWorkspaceRef.current = uiWorkspace
  }, [uiWorkspace])

  const localeStore = useMemo<Store<string> | undefined>(() => {
    const locale = ctx.locale
    if (locale === undefined) return undefined
    return {
      getSnapshot: () => (locale.getSnapshot().active === 'en' ? 'en' : 'zh'),
      subscribe: (l) => (locale.subscribe ? locale.subscribe(l) : () => {}),
    }
  }, [ctx])
  const lang = useStoreValue(localeStore, 'zh' as Lang) as Lang
  const t = useMemo(() => makeT(lang), [lang])

  const now = useNow(30000)
  const groups = useMemo(() => computeGroups(list, status, now, archived), [list, status, now, archived])
  /** 顶部需要关注的会话数（进行中 + 已完成未读）；底部折叠的空闲不计入角标。 */
  const attention = groups.active.length + groups.done.length
  const [idleOpen, setIdleOpenState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(IDLE_OPEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const setIdleOpen = useCallback((next: boolean) => {
    setIdleOpenState(next)
    try {
      localStorage.setItem(IDLE_OPEN_KEY, next ? '1' : '0')
    } catch { /* 隐私模式等场景忽略 */ }
  }, [])

  /* tab 状态 → region 属性（CSS 负责隐藏官方树） */
  useEffect(() => {
    region.setAttribute('data-dsh-as-tab', tab)
    return () => region.removeAttribute('data-dsh-as-tab')
  }, [region, tab])

  const open = useCallback(
    (id: string) => {
      try {
        const ws = uiWorkspaceRef.current
        if (ws !== undefined && typeof ws.openSession === 'function') {
          /* 官方导航：retain(mainView) + selection.set，主视图随之切换 */
          ws.openSession(id)
          return
        }
        if (typeof ctx.sessions.open === 'function') {
          ctx.sessions.open(id)
          return
        }
        console.error('[dsh-active-sessions] no navigation service available (uiWorkspace.openSession missing)')
      } catch (error) {
        console.error('[dsh-active-sessions] open failed:', error)
      }
    },
    [ctx],
  )

  return (
    <>
      <div className="dsh-as-strip" role="tablist">
        <button
          type="button"
          role="tab"
          className="dsh-as-tab"
          aria-selected={tab === 'workspace'}
          onClick={() => setTab('workspace')}
        >
          {t('tab.workspace')}
        </button>
        <button
          type="button"
          role="tab"
          className="dsh-as-tab"
          aria-selected={tab === 'active'}
          aria-label={t('tab.active.aria', { n: attention })}
          onClick={() => setTab('active')}
        >
          {t('tab.active')}
          {attention > 0 && <span className="dsh-as-count">{attention}</span>}
        </button>
      </div>
      {tab === 'active' && (
        <div className="dsh-as-list" role="tabpanel">
          {attention === 0 && groups.idle.length === 0 && <div className="dsh-as-empty">{t('empty')}</div>}
          {groups.active.length > 0 && (
            <Section label={t('section.active')} rows={groups.active} now={now} t={t} onOpen={open} />
          )}
          {groups.done.length > 0 && (
            <Section label={t('section.done')} rows={groups.done} now={now} t={t} onOpen={open} />
          )}
          {groups.idle.length > 0 && (
            <Section
              label={t('section.idle')}
              rows={groups.idle}
              now={now}
              t={t}
              onOpen={open}
              open={idleOpen}
              onToggle={() => setIdleOpen(!idleOpen)}
            />
          )}
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* DOM 注入胶水                                                        */
/* ------------------------------------------------------------------ */

const HOST_ATTR = 'data-dsh-active-sessions'

function findSidebarRoot(): HTMLElement | null {
  const viaSlot = document.querySelector<HTMLElement>('[data-slot="sidebar"] > [class*="_root"]')
  if (viaSlot !== null) return viaSlot
  return document.querySelector<HTMLElement>('[data-pane="sidebar"] [class*="_root"]')
}

/**
 * Client plugin entry：把 tab 宿主挂进官方 sidebar 的 regionArea，
 * 并用 MutationObserver + 定时器守卫（官方 React 重渲染/折叠切换后自愈）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    let disposed = false
    let host: HTMLDivElement | null = null
    let root: Root | null = null
    let region: HTMLElement | null = null
    let sidebarRoot: HTMLElement | null = null
    let raf = 0
    let observedRoot: HTMLElement | null = null

    injectCss()

    const teardownHost = (): void => {
      if (root !== null) {
        root.unmount()
        root = null
      }
      if (host !== null) {
        host.remove()
        host = null
      }
      if (region !== null) region.removeAttribute('data-dsh-as-tab')
    }

    const isCollapsed = (el: HTMLElement): boolean =>
      Array.from(el.classList).some((c) => c.includes('collapsed'))

    const ensure = (): void => {
      if (disposed) return
      const sr = findSidebarRoot()
      if (sr === null) {
        teardownHost()
        region = null
        sidebarRoot = null
        return
      }
      sidebarRoot = sr
      sr.setAttribute('data-dsh-as-collapsed', isCollapsed(sr) ? '1' : '0')
      const r = sr.querySelector<HTMLElement>('[class*="regionArea"]')
      if (r === null) {
        teardownHost()
        region = null
        return
      }
      if (region !== r) {
        teardownHost()
        region = r
      }
      if (host === null || host.parentElement !== region) {
        teardownHost()
        host = document.createElement('div')
        host.setAttribute(HOST_ATTR, '')
        region.prepend(host)
        root = createRoot(host)
        root.render(<SidebarTabsApp ctx={ctx} region={region} />)
      }
      if (observedRoot !== sr) {
        observedRoot = sr
        observer.disconnect()
        observer.observe(sr, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
        })
        observer.observe(document.body, { childList: true })
      }
    }

    const schedule = (): void => {
      if (disposed || raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        ensure()
      })
    }

    const observer = new MutationObserver((records) => {
      /* 忽略宿主自身的变化，避免自激 */
      const foreign = records.some(
        (m) =>
          (m.target instanceof Element && m.target.closest('[' + HOST_ATTR + ']') === null) ||
          !(m.target instanceof Element),
      )
      if (foreign) schedule()
    })
    const timer = setInterval(schedule, 2000)

    ensure()

    return () => {
      disposed = true
      if (raf !== 0) cancelAnimationFrame(raf)
      clearInterval(timer)
      observer.disconnect()
      teardownHost()
      if (sidebarRoot !== null) sidebarRoot.removeAttribute('data-dsh-as-collapsed')
      removeCss()
    }
  }, 'dsh-active-sessions: sidebar tab')
}
