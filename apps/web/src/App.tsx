import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, CircleAlert, Download, KeyRound, LayoutDashboard, LogOut, MessageSquare, Monitor, Moon, MoreHorizontal, Pencil, Plus, Power, Radar, RefreshCw, Search, Settings2, Sun, Trash2, X } from 'lucide-react';
import type { KeyView, Provider } from '../../../packages/shared/types.ts';
import { adapterNames } from '../../../packages/shared/types.ts';
import { api, dateTime, relativeTime } from './api.ts';
import type { AppState } from './api.ts';
import { Badge, Button, Empty, Modal, Section, Segmented } from './components/ui.tsx';
import { BackupPanel, ChannelForm, FormError, ImportForm, KeyForm, ProviderForm, SettingsForm } from './components/forms.tsx';
import { QQDriver } from './components/qq-driver.tsx';
import { Balance, Delta, KeyDetail, KeyStatus, Overview, TaskLog, UsageBar, keyState } from './components/quota-views.tsx';
type Page = 'overview' | 'keys' | 'channels' | 'settings';
type DialogState = { kind: 'provider'; initial?: Provider } | { kind: 'key'; initial?: KeyView; providerId?: string }
  | { kind: 'import'; providerId?: string } | { kind: 'detail'; keyId: string }
  | { kind: 'delete'; title: string; description: string; path: string };
const nav = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'keys', label: '额度', icon: KeyRound },
  { id: 'channels', label: '消息', icon: MessageSquare },
  { id: 'settings', label: '设置', icon: Settings2 },
] as const;
const filters = [{ id: 'all', label: '全部' }, { id: 'attention', label: '需关注' }, { id: 'disabled', label: '已停用' }] as const;
type Filter = typeof filters[number]['id'];
function pageFromHash(): Page { const hash = window.location.hash.slice(1); return nav.some(p => p.id === hash) ? hash as Page : 'overview'; }
function Login({ done }: { done: () => void }) {
  const [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <div className="login-wrap"><form className="login-card" onSubmit={e => { e.preventDefault(); setBusy(true); void api('/auth', 'POST', { password }).then(done).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>
    <div className="brand"><span className="brand-icon"><Radar size={20} /></span>QuotaRadar</div>
    <label className="field"><span>管理密码</span><input type="password" required autoFocus autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
    <FormError error={error} /><Button type="submit" loading={busy}>登录<ArrowRight size={16} /></Button></form></div>;
}
function RowMenu({ label, items }: { label: string; items: { label: string; icon: typeof Pencil; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return <div className="row-menu" ref={ref}><button type="button" className="icon-button" aria-label={`${label} 的更多操作`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal size={16} /></button>
    {open && <div className="menu" role="menu">{items.map(item => <button key={item.label} type="button" role="menuitem" className={item.danger ? 'danger' : undefined} onClick={() => { setOpen(false); item.onClick(); }}><item.icon size={14} />{item.label}</button>)}</div>}</div>;
}
export function App() {
  const client = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api<{ authenticated: boolean; required: boolean }>('/auth'), retry: false });
  const [page, setPage] = useState<Page>(pageFromHash), [dialog, setDialog] = useState<DialogState | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('qr-theme') ?? 'system');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [search, setSearch] = useState(''), [filter, setFilter] = useState<Filter>('all'), [providerFilter, setProviderFilter] = useState('');
  const [busy, setBusy] = useState(false), [platform, setPlatform] = useState<'qq' | 'telegram'>('qq');
  const state = useQuery({ queryKey: ['state'], queryFn: () => api<AppState>('/state'), enabled: auth.data?.authenticated === true,
    refetchInterval: q => q.state.data?.tasks.some(t => t.state === 'queued' || t.state === 'running') ? 1500 : 5000 });
  const data = state.data;
  useEffect(() => { const handler = () => setPage(pageFromHash()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); localStorage.setItem('qr-theme', theme); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { const handler = () => { client.setQueryData(['auth'], { authenticated: false, required: true }); client.removeQueries({ queryKey: ['state'] }); setDialog(null); }; window.addEventListener('qr-unauthorized', handler); return () => window.removeEventListener('qr-unauthorized', handler); }, [client]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), notice.error ? 8000 : 3500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (providerFilter && data && !data.providers.some(p => p.id === providerFilter)) setProviderFilter(''); }, [data, providerFilter]);
  const invalidate = async () => { await client.invalidateQueries({ queryKey: ['state'] }); await client.invalidateQueries({ queryKey: ['history'] }); };
  const notify = (text: string, error = false) => setNotice({ text, error });
  const logout = () => void api('/auth', 'DELETE').then(() => {
    client.setQueryData(['auth'], { authenticated: false, required: true });
    client.removeQueries({ predicate: query => query.queryKey[0] !== 'auth' });
    setDialog(null); setNotice(null);
  }).catch(error => notify(error.message, true));
  const perform = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true); try { await work(); await invalidate(); if (success) notify(success); }
    catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  };
  const refresh = (body: { ids?: string[]; providerId?: string } = {}) => perform(async () => {
    const result = await api<{ tasks: unknown[] }>('/refresh', 'POST', body); notify(result.tasks.length ? `正在查询 ${result.tasks.length} 个 Key` : '没有可查询的启用 Key');
  });
  const saved = async (path: string, method: string, value: unknown, text = '已保存') => { await api(path, method, value); await invalidate(); setDialog(null); notify(text); };
  if (auth.isPending) return <div className="loading-screen"><Radar size={32} className="pulse" /></div>;
  if (auth.isError) return <div className="loading-screen"><CircleAlert size={32} /><h1>无法连接服务</h1><p>{auth.error.message}</p><Button onClick={() => void auth.refetch()}>重试</Button></div>;
  if (!auth.data?.authenticated) return <Login done={() => void auth.refetch()} />;
  const running = data?.tasks.filter(t => t.state === 'queued' || t.state === 'running').length ?? 0;
  const go = (target: Page) => { window.location.hash = target; setPage(target); };
  const deleteProvider = (provider: Provider) => perform(async () => {
    const impact = await api<{ keys: number; snapshots: number }>(`/providers/${provider.id}/impact`);
    setDialog({ kind: 'delete', title: `删除 ${provider.name}？`, description: `将同时删除 ${impact.keys} 个 Key 和 ${impact.snapshots} 条历史，无法撤销。只想暂停请在编辑中停用。`, path: `/providers/${provider.id}` });
  });
  const filtered = data?.keys.filter(k => (!providerFilter || k.providerId === providerFilter)
    && (!search || `${k.name} ${k.providerName} ${k.tags.join(' ')} ${k.mask}`.toLowerCase().includes(search.toLowerCase()))
    && (filter === 'all' || (filter === 'attention' && keyState(k).attention) || (filter === 'disabled' && !k.enabled))) ?? [];
  const attentionCount = data?.keys.filter(k => keyState(k).attention).length ?? 0;
  const activeProvider = data?.providers.find(p => p.id === providerFilter);
  const themeLabel = theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色';
  const channelDot = (id: 'qq' | 'telegram') => { const c = data?.channels.find(x => x.platform === id); return !c?.enabled ? null : data?.statuses[id].connected ? 'status-dot' : 'status-dot warn-dot'; };
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#overview"><span className="brand-icon"><Radar size={17} strokeWidth={1.8} /></span><span>QuotaRadar</span></a>
      <nav aria-label="主导航">{nav.map(item => <a key={item.id} href={`#${item.id}`} className={page === item.id ? 'nav-item active' : 'nav-item'} aria-current={page === item.id ? 'page' : undefined}><item.icon size={17} /><span>{item.label}</span>{item.id === 'keys' && attentionCount > 0 && <span className="nav-dot" aria-label={`${attentionCount} 个需要关注`} />}</a>)}</nav>
      <div className="topbar-actions">{running > 0 && <span className="topbar-indicator" title="正在查询"><RefreshCw size={13} className="spin" />{running}</span>}{state.isError && <span className="topbar-indicator error-text"><CircleAlert size={14} />连接中断</span>}
        <button className="icon-button" aria-label={`外观：${themeLabel}，点击切换`} title={`外观：${themeLabel}`} onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}>{theme === 'dark' ? <Moon size={16} /> : theme === 'light' ? <Sun size={16} /> : <Monitor size={16} />}</button>
        {auth.data.required && <button aria-label="退出登录" title="退出登录" className="icon-button" onClick={logout}><LogOut size={16} /></button>}</div></header>
    <main id="main-content">
      {state.isError && data && <div className="inline-error" role="alert">无法更新数据：{state.error.message}。显示的是上次的结果。<Button variant="ghost" onClick={() => void state.refetch()}>重试</Button></div>}
      {!data && (state.isError ? <div className="loading-screen"><CircleAlert size={30} /><p>{state.error.message}</p><Button onClick={() => void state.refetch()}>重试</Button></div> : <div className="loading-screen"><RefreshCw className="spin" /></div>)}
      {data && <>
        {page === 'overview' && <><header className="page-heading"><h1>概览</h1>{data.keys.some(k => k.enabled) && <Button variant="outline" loading={busy} onClick={() => void refresh()}><RefreshCw size={15} />全部刷新</Button>}</header>
          <Overview data={data} addProvider={() => setDialog({ kind: 'provider' })} openKey={key => setDialog({ kind: 'detail', keyId: key.id })} showAttention={() => { setFilter('attention'); setProviderFilter(''); go('keys'); }} /></>}
        {page === 'keys' && <><header className="page-heading"><h1>额度</h1>{data.providers.length > 0 && <div className="page-actions"><Button variant="outline" onClick={() => setDialog({ kind: 'import', providerId: providerFilter || undefined })}><Download size={15} />批量导入</Button><Button onClick={() => setDialog({ kind: 'key', providerId: providerFilter || undefined })}><Plus size={15} />添加 Key</Button></div>}</header>
          {!data.providers.length ? <section className="panel"><Empty title="先添加一个供应商" description="填写站点地址和查询类型，之后就能添加 Key。" action="添加供应商" onAction={() => setDialog({ kind: 'provider' })} /></section> : <div className="keys-layout">
            <aside className="provider-list" aria-label="供应商"><div className="provider-list-head"><span>供应商</span><button className="icon-button" aria-label="添加供应商" title="添加供应商" onClick={() => setDialog({ kind: 'provider' })}><Plus size={15} /></button></div>
              <button className={!providerFilter ? 'provider-item active' : 'provider-item'} aria-pressed={!providerFilter} onClick={() => setProviderFilter('')}><span>全部</span><small>{data.keys.length}</small></button>
              {data.providers.map(p => <button key={p.id} className={providerFilter === p.id ? 'provider-item active' : 'provider-item'} aria-pressed={providerFilter === p.id} onClick={() => setProviderFilter(p.id)}><span>{p.name}{!p.enabled && <Badge>停用</Badge>}</span><small>{data.keys.filter(k => k.providerId === p.id).length}</small></button>)}</aside>
            <section className="panel keys-panel">
              {activeProvider && <div className="provider-bar"><div><strong>{activeProvider.name}</strong><span>{activeProvider.baseUrl} · {adapterNames[activeProvider.adapter]}</span></div>
                <div className="provider-bar-actions"><Button variant="ghost" disabled={!activeProvider.enabled || busy} onClick={() => void refresh({ providerId: activeProvider.id })}><RefreshCw size={14} />刷新</Button><Button variant="ghost" onClick={() => setDialog({ kind: 'provider', initial: activeProvider })}><Pencil size={14} />编辑</Button><Button variant="ghost" className="danger-text" onClick={() => void deleteProvider(activeProvider)}><Trash2 size={14} />删除</Button></div></div>}
              <div className="toolbar"><div className="search-input"><Search size={15} /><input type="search" aria-label="搜索 Key" placeholder="搜索别名、标签或掩码" value={search} onChange={e => setSearch(e.target.value)} /></div>
                <Segmented label="状态筛选" value={filter} onChange={setFilter} options={filters.map(f => ({ id: f.id, label: f.id === 'attention' && attentionCount ? <>{f.label}<span className="count">{attentionCount}</span></> : f.label }))} /></div>
              {filtered.length ? <div className="key-table"><table><thead><tr><th>Key</th><th>剩余额度</th><th>变化</th><th>状态</th><th>更新</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{filtered.map(key => {
                const provider = data.providers.find(p => p.id === key.providerId)!;
                return <tr key={key.id} className={!key.enabled ? 'row-disabled' : undefined}><td data-label="Key"><button className="key-name" onClick={() => setDialog({ kind: 'detail', keyId: key.id })}>{key.name}</button><span className="key-sub">{!providerFilter && <>{key.providerName} · </>}<code>{key.mask}</code></span>{key.tags.length > 0 && <span className="key-tags">{key.tags.map(t => <span key={t}>{t}</span>)}</span>}</td>
                  <td data-label="剩余"><Balance item={key} /><UsageBar item={key} /></td><td data-label="变化"><Delta item={key} /></td><td data-label="状态"><KeyStatus item={key} /></td>
                  <td data-label="更新" className="time-cell" title={key.latest ? dateTime(key.latest.sampledAt) : undefined}>{relativeTime(key.latest?.sampledAt)}</td>
                  <td className="actions-cell"><button className="icon-button" aria-label={`刷新 ${key.name}`} title="刷新" disabled={!key.enabled || !provider.enabled} onClick={() => void refresh({ ids: [key.id] })}><RefreshCw size={15} /></button>
                    <RowMenu label={key.name} items={[{ label: '编辑', icon: Pencil, onClick: () => setDialog({ kind: 'key', initial: key }) },
                      { label: key.enabled ? '停用' : '启用', icon: Power, onClick: () => void perform(() => api(`/keys/${key.id}`, 'PUT', { ...key, enabled: !key.enabled }), key.enabled ? '已停用' : '已启用，正在查询') },
                      { label: '删除', icon: Trash2, danger: true, onClick: () => setDialog({ kind: 'delete', title: `删除 ${key.name}？`, description: '将同时删除它的全部采样和查询记录，无法撤销。只想暂停请改为停用。', path: `/keys/${key.id}` }) }]} /></td></tr>;
              })}</tbody></table></div>
                : search || filter !== 'all' ? <Empty title="没有匹配的 Key" description="换个关键词或筛选条件试试。" /> : <Empty title="还没有 Key" description="添加一个 Key，或从文本批量导入。" action="添加 Key" onAction={() => setDialog({ kind: 'key', providerId: providerFilter || undefined })} />}
            </section></div>}</>}
        {page === 'channels' && <><header className="page-heading"><h1>消息</h1><Segmented label="选择平台" value={platform} onChange={setPlatform} options={(['qq', 'telegram'] as const).map(id => ({ id, label: <>{channelDot(id) && <span className={channelDot(id)!} />}{id === 'qq' ? 'QQ' : 'Telegram'}</> }))} /></header>
          <div className="channel-layout"><div>{platform === 'qq' && <QQDriver changed={invalidate} connected={Boolean(data.channels.find(c => c.platform === 'qq')?.hasToken)} />}
            {data.channels.filter(channel => channel.platform === platform).map(channel => {
              const status = data.statuses[channel.platform], qq = channel.platform === 'qq';
              const label = !channel.enabled ? '未启用' : !status.connected ? '连接中' : qq && status.accountOnline === false ? '账号离线' : '运行中';
              return <Section key={channel.platform} title={qq ? 'QQ Bot' : 'Telegram Bot'} description="谁能用、提醒发到哪里" actions={<Badge tone={!channel.enabled ? 'neutral' : label === '运行中' ? 'green' : 'amber'}>{label}</Badge>} className="padded-panel">
                {status.error && <div className="inline-error">{status.error}</div>}
                <ChannelForm key={JSON.stringify(channel)} channel={channel} save={input => saved('/channels', 'PUT', input)} /></Section>;
            })}</div>
            <aside className="panel command-panel"><h2>聊天命令</h2><p>QQ 和 Telegram 通用。</p><dl>{[['/balance 或 额度', '查看余额'], ['/refresh 或 刷新额度', '立即查询并返回结果'], ['/low', '低额度和异常'], ['/status', '运行状态'], ['/help', '命令说明']].map(([command, label]) => <div key={command}><dt><code>{command}</code></dt><dd>{label}</dd></div>)}</dl><p className="form-note">命令后加别名或供应商名，只看匹配的 Key。</p></aside></div></>}
        {page === 'settings' && <><header className="page-heading"><h1>设置</h1></header><div className="settings-layout"><div>
          <Section title="巡检与提醒" className="padded-panel"><SettingsForm key={JSON.stringify(data.settings)} settings={data.settings} save={input => saved('/settings', 'PUT', input)} /></Section>
          <Section title="备份" className="padded-panel"><BackupPanel restored={async () => { await invalidate(); notify('已恢复，消息平台已停用'); }} /></Section></div>
          <Section title="最近查询" description="最近 100 次"><TaskLog tasks={data.tasks} names={Object.fromEntries(data.keys.map(k => [k.id, k.name]))} /></Section></div></>}
      </>}
    </main>
    {dialog && data && <Modal title={dialog.kind === 'provider' ? dialog.initial ? '编辑供应商' : '添加供应商' : dialog.kind === 'key' ? dialog.initial ? '编辑 Key' : '添加 Key' : dialog.kind === 'import' ? '批量导入 Key' : dialog.kind === 'delete' ? dialog.title : data.keys.find(k => k.id === dialog.keyId)?.name ?? 'Key 详情'}
      description={dialog.kind === 'delete' ? dialog.description : undefined} onClose={() => setDialog(null)} wide={dialog.kind === 'detail'}>
      {dialog.kind === 'provider' && <ProviderForm initial={dialog.initial} cancel={() => setDialog(null)} save={async input => {
        const result = await api<Provider>(dialog.initial ? `/providers/${dialog.initial.id}` : '/providers', dialog.initial ? 'PUT' : 'POST', input); await invalidate();
        if (dialog.initial) { setDialog(null); notify('已保存'); } else { setProviderFilter(result.id); go('keys'); setDialog({ kind: 'key', providerId: result.id }); notify('供应商已添加，接着添加 Key'); }
      }} />}
      {dialog.kind === 'key' && <KeyForm initial={dialog.initial} providerId={dialog.providerId} providers={data.providers} cancel={() => setDialog(null)} save={input => saved(dialog.initial ? `/keys/${dialog.initial.id}` : '/keys', dialog.initial ? 'PUT' : 'POST', input, dialog.initial ? '已保存' : '已添加，正在查询')} />}
      {dialog.kind === 'import' && <ImportForm providers={data.providers} providerId={dialog.providerId} cancel={() => setDialog(null)} done={async count => { await invalidate(); setDialog(null); notify(`已导入 ${count} 个 Key，正在查询`); }} />}
      {dialog.kind === 'detail' && (() => { const key = data.keys.find(k => k.id === dialog.keyId); return key ? <KeyDetail item={key} refreshMinutes={data.settings.refreshMinutes} refresh={() => void refresh({ ids: [key.id] })} /> : <Empty title="这个 Key 已被删除" description="关闭窗口查看其他 Key。" />; })()}
      {dialog.kind === 'delete' && <div className="form-actions"><Button variant="outline" onClick={() => setDialog(null)}>取消</Button><Button variant="danger" loading={busy} onClick={() => void perform(async () => { await api(dialog.path, 'DELETE'); setDialog(null); }, '已删除')}><Trash2 size={15} />删除</Button></div>}
    </Modal>}
    {notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleAlert size={17} /> : <CheckCircle2 size={17} />}<span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}
  </div>;
}
