/**
 * Bun native — browser half.
 *
 * Adds a "Bun native" page to Settings that renders the Host's dashboard
 * payload (`GET /api/bun-native/status`): the detected project, the Bun runtime
 * properties probe, the offline API catalog coverage, and the health checks the
 * `bun_doctor` tool returns. The page is read-only; actions stay in the agent
 * tools so every change is a normal, auditable tool call.
 *
 * Plain JS with React from the browser module table, per the Harness UI plugin
 * rules: theme tokens only, no DOM outside the component, localized via the
 * Client locale service.
 */
window.__ModuleLoader__.load({
  id: '@local/bun-native',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'bun-native'

    const DICTS = {
      en: {
        nav: 'Bun native',
        title: 'Bun native',
        subtitle: 'Project detection, Bun runtime properties and the offline API catalog.',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        updated: 'Updated',
        loading: 'Reading Bun status…',
        errorTitle: 'Could not read the Bun status endpoint.',
        retry: 'Retry',
        project: 'Project',
        runtime: 'Bun runtime',
        catalog: 'API catalog',
        checks: 'Health checks',
        kind: 'Classification',
        confidence: 'Confidence',
        directory: 'Directory',
        lockfile: 'Lockfile',
        linker: 'Linker',
        workspace: 'Workspace',
        signals: 'Signals',
        scripts: 'Scripts',
        features: 'Native properties',
        missing: 'missing',
        coverage: 'Catalog coverage',
        curated: 'curated',
        uncovered: 'uncovered',
        categories: 'categories',
        docs: 'Bun globals reference',
        hint: 'Ask the agent to run bun_doctor to include the project\'s bun:test suite; schedule a task with that prompt for automated health checks.',
        pass: 'pass',
        warn: 'warn',
        fail: 'fail',
        noProject: 'No Bun project found in this workspace.',
        none: 'none',
        member: 'member',
        root: 'root',
        workspaceMember: 'member of',
        workspaceRoot: 'root of',
        catalogMatch: 'Catalog matches this runtime',
        catalogMismatch: 'Catalog was built for another Bun version',
        checkedAt: 'checked',
      },
      zh: {
        nav: 'Bun 原生',
        title: 'Bun 原生',
        subtitle: '项目识别、Bun 运行时属性与离线 API 目录。',
        refresh: '刷新',
        refreshing: '刷新中…',
        updated: '更新于',
        loading: '正在读取 Bun 状态…',
        errorTitle: '无法读取 Bun 状态接口。',
        retry: '重试',
        project: '项目',
        runtime: 'Bun 运行时',
        catalog: 'API 目录',
        checks: '健康检查',
        kind: '分类',
        confidence: '置信度',
        directory: '目录',
        lockfile: '锁文件',
        linker: '链接方式',
        workspace: '工作区',
        signals: '信号',
        scripts: '脚本',
        features: '原生属性',
        missing: '缺失',
        coverage: '目录覆盖率',
        curated: '已收录',
        uncovered: '未收录',
        categories: '个分类',
        docs: 'Bun 全局 API 参考',
        hint: '让代理运行 bun_doctor 可附带项目的 bun:test 测试；把同样的提示词做成定时任务即可自动巡检。',
        pass: '通过',
        warn: '警告',
        fail: '失败',
        noProject: '此工作区未发现 Bun 项目。',
        none: '无',
        member: '成员',
        root: '根',
        workspaceMember: '成员于',
        workspaceRoot: '根，模式',
        catalogMatch: '目录与当前运行时一致',
        catalogMismatch: '目录基于其它 Bun 版本生成',
        checkedAt: '检查于',
      },
    }

    let localeService = null
    let translate = (key) => key
    const t = (key) => translate(key)

    const useStore = React.useSyncExternalStore
      ?? function fallbackStore(subscribe, getSnapshot) {
        const [, force] = React.useReducer((value) => value + 1, 0)
        React.useEffect(() => subscribe(force), [subscribe])
        return getSnapshot()
      }

    const S = {
      page: { display: 'grid', gap: '12px', padding: '8px 4px 24px', maxWidth: '980px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '1.45' },
      header: { display: 'flex', alignItems: 'flex-start', gap: '12px', justifyContent: 'space-between', flexWrap: 'wrap' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600 },
      subtitle: { margin: '2px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      headerMeta: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      sticky: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      button: { appearance: 'none', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', borderRadius: '6px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer' },
      buttonDisabled: { opacity: 0.6, cursor: 'default' },
      summary: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      pill: (color) => ({ border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '999px', padding: '2px 10px', fontSize: '12px', color }),
      grid: { display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', alignItems: 'start' },
      card: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '12px 14px', display: 'grid', gap: '8px', alignContent: 'start' },
      cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' },
      cardTitle: { margin: 0, fontSize: '13px', fontWeight: 600 },
      row: { display: 'flex', gap: '10px', alignItems: 'baseline', justifyContent: 'space-between', fontSize: '12px' },
      key: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      val: { textAlign: 'right', wordBreak: 'break-word', minWidth: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11.5px' },
      chips: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      chip: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '999px', padding: '1px 8px', fontSize: '11px' },
      dot: (status) => ({
        display: 'inline-block',
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        marginTop: '5px',
        background: status === 'pass'
          ? 'var(--dsw-alias-state-success-primary)'
          : status === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : status === 'fail'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-state-idle-primary)',
        flex: '0 0 auto',
      }),
      check: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px', alignItems: 'start' },
      checkTitle: { fontSize: '12px' },
      detail: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px', wordBreak: 'break-word' },
      error: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '12px 14px', display: 'grid', gap: '8px' },
      errorText: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      link: { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none' },
      barTrack: { height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' },
      barFill: (percent) => ({ height: '100%', width: `${percent}%`, background: 'var(--dsw-alias-brand-primary)' }),
      empty: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
    }

    function useLocaleRevision() {
      const subscribe = React.useCallback((listener) => localeService.subscribe(listener), [])
      const snapshot = React.useCallback(() => localeService.getSnapshot(), [])
      return useStore(subscribe, snapshot).revision
    }

    function useStatus() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const load = React.useCallback(async () => {
        setState({ phase: 'loading', data: null, error: null })
        try {
          const response = await fetch('/api/bun-native/status', {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setState({ phase: 'ready', data: await response.json(), error: null })
        } catch (error) {
          setState({ phase: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [])
      React.useEffect(() => {
        load()
      }, [load])
      return [state, load]
    }

    function Row(props) {
      if (props.value === null || props.value === undefined || props.value === '') return null
      return h('div', { style: S.row },
        h('span', { style: S.key }, props.label),
        h('span', { style: props.mono === true ? Object.assign({}, S.val, S.mono) : S.val }, props.value))
    }

    function Card(props) {
      return h('section', { style: S.card },
        h('div', { style: S.cardHead },
          h('h2', { style: S.cardTitle }, props.title),
          props.aside !== undefined ? h('span', { style: S.detail }, props.aside) : null),
        props.children)
    }

    function SummaryPills(props) {
      const summary = props.summary
      const items = [
        [summary.pass, 'pass', 'var(--dsw-alias-state-success-primary)'],
        [summary.warn, 'warn', 'var(--dsw-alias-state-warn-primary)'],
        [summary.fail, 'fail', 'var(--dsw-alias-state-error-primary)'],
      ]
      return h('div', { style: S.summary },
        items.map(([count, label, color]) => h('span', { key: label, style: S.pill(count > 0 ? color : 'var(--dsw-alias-label-secondary)') }, `${count} ${t(label)}`)))
    }

    function ProjectCard(props) {
      const project = props.project
      if (project === null) return h(Card, { title: t('project') }, h('span', { style: S.empty }, t('noProject')))
      const workspace = project.workspace
      const workspaceText = workspace === null
        ? null
        : workspace.role === 'root'
          ? `${t('workspaceRoot')} ${workspace.patterns.join(', ')}`
          : `${t('workspaceMember')} ${workspace.memberName ?? workspace.memberPath}`
      return h(Card, { title: t('project'), aside: project.confidence },
        h(Row, { label: t('kind'), value: project.kind }),
        h(Row, { label: t('directory'), value: project.directory, mono: true }),
        h(Row, { label: t('lockfile'), value: project.lockfile === null ? t('none') : `${project.lockfile.file} (${project.lockfile.kind})` }),
        h(Row, { label: t('linker'), value: project.linker.strategy }),
        h(Row, { label: t('workspace'), value: workspaceText }),
        project.packageJson !== null ? h(Row, { label: t('scripts'), value: project.packageJson.scripts.join(', ') }) : null,
        project.signals.length > 0
          ? h('div', { style: S.chips }, project.signals.map((signal) => h('span', { key: signal, style: S.chip }, signal)))
          : null)
    }

    function RuntimeCard(props) {
      const runtime = props.runtime
      if (runtime === null) return h(Card, { title: t('runtime') }, h('span', { style: S.empty }, t('loading')))
      const features = Object.entries(runtime.features ?? {})
      const missing = features.filter(([, value]) => value === 'missing' || value === 'undefined')
      return h(Card, { title: t('runtime'), aside: `Bun ${runtime.version}` },
        h(Row, { label: 'platform', value: `${runtime.platform}/${runtime.arch}`, mono: true }),
        h(Row, { label: t('features'), value: missing.length === 0 ? `${features.length} ✓` : `${missing.length} ${t('missing')}` }),
        h('div', { style: S.chips },
          features.map(([name, value]) => h('span', { key: name, style: Object.assign({}, S.chip, S.mono, value === 'missing' || value === 'undefined' ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) }, `${name}:${value}`))))
    }

    function CatalogCard(props) {
      const catalog = props.catalog
      const runtime = props.runtime
      const checked = runtime?.catalog?.checked ?? catalog.total
      const uncovered = runtime?.catalog?.uncoveredCount ?? 0
      const coverage = checked + uncovered === 0 ? 0 : Math.round((checked / (checked + uncovered)) * 100)
      return h(Card, { title: t('catalog'), aside: `Bun ${catalog.bunVersion}` },
        h(Row, { label: 'APIs', value: `${catalog.total}` }),
        h(Row, { label: t('categories'), value: `${catalog.categories}` }),
        h('div', { style: S.row },
          h('span', { style: S.key }, t('coverage')),
          h('span', { style: S.val }, `${coverage}% — ${checked} ${t('curated')}, ${uncovered} ${t('uncovered')}`)),
        h('div', { style: S.barTrack }, h('div', { style: S.barFill(coverage) })),
        h(Row, {
          label: t('catalogMatch'),
          value: catalog.bunVersion === runtime?.version ? '✓' : t('catalogMismatch'),
        }),
        h('a', { style: Object.assign({}, S.link, { fontSize: '12px' }), href: 'https://bun.com/reference/globals/bun', target: '_blank', rel: 'noreferrer' }, t('docs') + ' ↗'))
    }

    function ChecksCard(props) {
      return h(Card, { title: t('checks'), aside: `${props.checks.length} ${t('checkedAt')}` },
        props.checks.length === 0
          ? h('span', { style: S.empty }, t('loading'))
          : h('div', { style: { display: 'grid', gap: '8px' } },
            props.checks.map((check) => h('div', { key: check.id, style: S.check },
              h('span', { style: S.dot(check.status) }),
              h('div', null,
                h('div', { style: S.checkTitle }, check.title),
                h('div', { style: S.detail }, check.detail))))))
    }

    function Dashboard() {
      useLocaleRevision()
      const [state, load] = useStatus()

      const header = h('div', { style: S.header },
        h('div', null,
          h('h1', { style: S.title }, t('title')),
          h('p', { style: S.subtitle }, t('subtitle'))),
        h('div', { style: S.headerMeta },
          state.data !== null
            ? h('span', { style: S.sticky }, `${t('updated')} ${new Date(state.data.generatedAt).toLocaleTimeString()}`)
            : null,
          h('button', {
            type: 'button',
            style: state.phase === 'loading' ? Object.assign({}, S.button, S.buttonDisabled) : S.button,
            disabled: state.phase === 'loading',
            onClick: load,
          }, state.phase === 'loading' ? t('refreshing') : t('refresh'))))

      if (state.phase === 'loading') {
        return h('div', { style: S.page }, header, h('div', { style: S.hint }, t('loading')))
      }
      if (state.phase === 'error') {
        return h('div', { style: S.page }, header,
          h('div', { style: S.error },
            h('span', { style: S.errorText }, `${t('errorTitle')} ${state.error}`),
            h('button', { type: 'button', style: S.button, onClick: load }, t('retry'))))
      }

      const data = state.data
      return h('div', { style: S.page },
        header,
        h(SummaryPills, { summary: data.summary }),
        h('div', { style: S.grid },
          h(ProjectCard, { project: data.project }),
          h(RuntimeCard, { runtime: data.runtime }),
          h(CatalogCard, { catalog: data.catalog, runtime: data.runtime }),
          h(ChecksCard, { checks: data.checks })),
        h('div', { style: S.hint }, t('hint')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(context) {
        localeService = context.locale
        context.effect(() => {
          const disposeEn = context.locale.register(NS, 'en', DICTS.en)
          const disposeZh = context.locale.register(NS, 'zh', DICTS.zh)
          return () => {
            disposeEn()
            disposeZh()
          }
        })
        translate = context.locale.bind(NS)
        context.slots.inject('settings.section', () => context.slots.register({
          name: 'settings.section',
          id: 'bun-native',
          order: 25,
          label: () => t('nav'),
        }, Dashboard))
      },
    }
  },
})
