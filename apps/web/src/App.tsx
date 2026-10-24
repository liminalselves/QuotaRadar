import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowUpRight, CheckCircle2, ChevronRight, CircleAlert, Download, KeyRound, LayoutDashboard, LogOut, MessageSquare, Moon, MoreHorizontal, Plus, Radar, RefreshCw, Search, Settings2, Sun, Trash2, Pencil, X, Server, Power } from 'lucide-react';
import type { ChannelInput, KeyView, Provider, ProviderInput } from '../../../packages/shared/types.ts';
import { adapterNames } from '../../../packages/shared/types.ts';
import { api, dateTime } from './api.ts';
import type { AppState } from './api.ts';
import { Badge, Button, Empty, Modal } from './components/ui.tsx';
import { BackupPanel, ChannelForm, FormError, ImportForm, KeyForm, ProviderForm, SettingsForm } from './components/forms.tsx';
import { QQDriver } from './components/qq-driver.tsx';
import { Balance, Delta, KeyDetail, KeyStatus, Overview, TaskLog } from './components/quota-views.tsx';
type Page = 'overview' | 'keys' | 'channels' | 'settings';
type DialogState = { kind: 'provider'; initial?: Provider } | { kind: 'key'; initial?: KeyView; providerId?: string }
  | { kind: 'import'; providerId?: string } | { kind: 'detail'; keyId: string }
  | { kind: 'delete'; title: string; description: string; path: string };
const nav = [
  { id: 'overview', label: '概览', icon: LayoutDashboard, subtitle: '你的 AI 额度，一目了然。' },
  { id: 'keys', label: '额度管理', icon: KeyRound, subtitle: '统一管理供应商和 Key，不再来回切换。' },
  { id: 'channels', label: '消息平台', icon: MessageSquare, subtitle: '在聊天里查询，让提醒主动找到你。' },
  { id: 'settings', label: '设置', icon: Settings2, subtitle: '按照你的节奏，刷新、记录与提醒。' },
] as const;
function pageFromHash(): Page { const hash = window.location.hash.slice(1); return nav.some(p => p.id === hash) ? hash as Page : 'overview'; }
function Login({ done }: { done: () => void }) {
  const [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <div className="login-wrap"><div className="login-card"><div className="brand"><span className="brand-icon"><Radar size={25} /></span>QuotaRadar</div><h1>欢迎回来。</h1><p className="muted">输入管理密码，查看你的额度。</p><form onSubmit={e => { e.preventDefault(); setBusy(true); void api('/auth', 'POST', { password }).then(done).catch(e => setError(e.message)).finally(() => setBusy(false)); }}><label className="field"><span>管理密码</span><input type="password" required autoFocus autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><FormError error={error} /><Button type="submit" loading={busy}>进入管理台<ArrowUpRight size={17} /></Button></form></div></div>;
}
export function App() {
  const client = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api<{ authenticated: boolean; required: boolean }>('/auth'), retry: false });
  const [page, setPage] = useState<Page>(pageFromHash), [dialog, setDialog] = useState<DialogState | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('qr-theme') ?? 'system');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [platform, setPlatform] = useState<'qq' | 'telegram'>('qq');
  const state = useQuery({ queryKey: ['state'], queryFn: () => api<AppState>('/state'), enabled: auth.data?.authenticated === true, refetchInterval: 2500 });
  const data = state.data;
  useEffect(() => { const handler = () => setPage(pageFromHash()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); localStorage.setItem('qr-theme', theme); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { const handler = () => { client.setQueryData(['auth'], { authenticated: false, required: true }); client.removeQueries({ queryKey: ['state'] }); setDialog(null); }; window.addEventListener('qr-unauthorized', handler); return () => window.removeEventListener('qr-unauthorized', handler); }, [client]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), notice.error ? 10000 : 4500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { setSelected(ids => ids.filter(id => data?.keys.some(k => k.id === id) ?? false)); }, [data?.keys]);
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
    const result = await api<{ tasks: unknown[] }>('/refresh', 'POST', body); notify(result.tasks.length ? `已发起 ${result.tasks.length} 个查询，结果将自动更新` : '没有可刷新的启用 Key');
  });
  const saved = async (path: string, method: string, value: unknown, text = '已保存') => { await api(path, method, value); await invalidate(); setDialog(null); notify(text); };
  const currentPage = nav.find(p => p.id === page)!;
  if (auth.isPending) return <div className="loading-screen"><Radar size={35} className="pulse" /><p>正在连接 QuotaRadar…</p></div>;
  if (auth.isError) return <div className="loading-screen"><CircleAlert size={35} /><h1>暂时无法连接服务</h1><p>{auth.error.message}</p><Button onClick={() => void auth.refetch()}>重新连接</Button></div>;
  if (!auth.data?.authenticated) return <Login done={() => void auth.refetch()} />;
  const running = data?.tasks.filter(t => t.state === 'queued' || t.state === 'running').length ?? 0;
  const go = (target: Page) => { window.location.hash = target; setPage(target); };
  const deleteProvider = (provider: Provider) => perform(async () => {
    const impact = await api<{ keys: number; snapshots: number }>(`/providers/${provider.id}/impact`);
    setDialog({ kind: 'delete', title: `删除 ${provider.name}？`, description: `这会一并删除 ${impact.keys} 个 Key 和 ${impact.snapshots} 条采样历史，无法撤销。只想暂停查询，请改为停用供应商。`, path: `/providers/${provider.id}` });
  });
  const filtered = data?.keys.filter(k => (!search || `${k.name} ${k.providerName} ${k.tags.join(' ')} ${k.mask}`.toLowerCase().includes(search.toLowerCase())) && (filter === 'all' || (filter === 'low' && k.low) || (filter === 'failed' && k.lastTask?.state === 'failed') || (filter === 'stale' && k.stale) || (filter === 'disabled' && !k.enabled))) ?? [];
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#overview"><span className="brand-icon"><Radar size={23} strokeWidth={1.7} /></span><span>QuotaRadar<small>额度雷达</small></span></a><div className="sidebar-label">WORKSPACE</div><nav aria-label="主导航">{nav.map(item => <a key={item.id} href={`#${item.id}`} className={page === item.id ? 'nav-item active' : 'nav-item'} aria-current={page === item.id ? 'page' : undefined}><item.icon size={18} /><span>{item.label}</span>{item.id === 'keys' && Boolean(data?.keys.length) && <span className="nav-count">{data?.keys.length}</span>}</a>)}</nav>
    <div className="sidebar-bottom"><div className="sidebar-status"><span className={state.isError ? 'status-dot error-dot' : 'status-dot'} /><span>{state.isError ? '服务连接中断' : '本地工作空间'}<small>{data?.providers.length ?? 0} 个供应商 · {data?.keys.length ?? 0} 个 Key</small></span></div><div className="sidebar-controls"><select aria-label="外观主题" value={theme} onChange={e => setTheme(e.target.value)}><option value="system">跟随系统</option><option value="dark">深色外观</option><option value="light">浅色外观</option></select>{auth.data.required && <button aria-label="退出登录" className="icon-button" onClick={logout}><LogOut size={16} /></button>}</div><span className="version-label">QUOTARADAR / V0.1</span></div></aside>
    <div className="main-shell"><div className="topbar"><div><span>工作空间</span><ChevronRight size={14} /><strong>{currentPage.label}</strong></div><div className="topbar-actions"><span className="topbar-indicator"><span className={running ? 'status-dot pulse' : 'status-dot'} />{running ? `${running} 个查询进行中` : '额度管理工作台'}</span>{auth.data.required && <button aria-label="退出登录" className="icon-button mobile-logout" onClick={logout}><LogOut size={18} /></button>}</div></div>
      <main id="main-content"><header className="page-heading"><div><div className="eyebrow">{page === 'overview' ? 'YOUR QUOTA, IN SIGHT' : page.toUpperCase()}</div><h1>{currentPage.label}</h1><p>{currentPage.subtitle}</p></div><div className="page-actions">{(page === 'overview' || page === 'keys') && <><Button variant="outline" loading={busy} disabled={!data?.keys.some(k => k.enabled)} onClick={() => void refresh()}><RefreshCw size={16} />刷新全部</Button><Button onClick={() => setDialog({ kind: 'provider' })}><Plus size={16} />添加供应商</Button></>}</div></header>
        {state.isError && <div className="inline-error" role="alert">无法更新数据：{state.error.message}。当前保留上次读取结果。<Button variant="ghost" onClick={() => void state.refetch()}>重试</Button></div>}
        {!data && !state.isError && <div className="loading-screen"><RefreshCw className="spin" /><p>读取工作空间…</p></div>}
        {data && <>
          {page === 'overview' && <Overview data={data} addProvider={() => setDialog({ kind: 'provider' })} openKey={key => setDialog({ kind: 'detail', keyId: key.id })} />}
          {page === 'keys' && <><div className="toolbar"><div className="search-input"><Search size={17} /><input aria-label="搜索 Key、供应商或标签" placeholder="搜索 Key、供应商或标签…" value={search} onChange={e => setSearch(e.target.value)} /></div><select aria-label="按 Key 状态筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部状态</option><option value="low">低额度</option><option value="failed">查询失败</option><option value="stale">待更新</option><option value="disabled">已停用</option></select><span className="toolbar-count">{filtered.length} 个 Key</span><Button variant="outline" disabled={!data.providers.length} onClick={() => setDialog({ kind: 'import' })}><Download size={16} />批量导入</Button></div>
            {selected.length > 0 && <div className="selection-bar"><span>已选 {selected.length} 个 Key</span><Button variant="ghost" onClick={() => void refresh({ ids: selected })}>刷新所选</Button><Button variant="ghost" onClick={() => setSelected([])}>取消选择</Button></div>}
            {!data.providers.length ? <section className="panel"><Empty title="从一个供应商开始" description="选择查询类型，填写地址。之后可以一次添加多个 Key。" action="添加供应商" onAction={() => setDialog({ kind: 'provider' })} /></section> : data.providers.map(provider => {
              const keys = filtered.filter(k => k.providerId === provider.id);
              if ((search || filter !== 'all') && !keys.length) return null;
              return <section className="panel provider-panel" key={provider.id}><div className="provider-header"><span className="provider-initial">{provider.name.slice(0, 1)}</span><div className="provider-title"><h2>{provider.name}{!provider.enabled && <Badge>已停用</Badge>}</h2><span>{provider.baseUrl}<span className="provider-type">{adapterNames[provider.adapter]}</span></span></div><div className="provider-actions"><Button variant="ghost" aria-label={`刷新 ${provider.name}`} title="刷新供应商" disabled={!provider.enabled || !keys.length} onClick={() => void refresh({ providerId: provider.id })}><RefreshCw size={15} /></Button><Button variant="ghost" aria-label={`编辑 ${provider.name}`} onClick={() => setDialog({ kind: 'provider', initial: provider })}><Pencil size={15} /></Button><Button variant="ghost" aria-label={`删除 ${provider.name}`} onClick={() => void deleteProvider(provider)}><Trash2 size={15} /></Button><Button variant="outline" onClick={() => setDialog({ kind: 'key', providerId: provider.id })}><Plus size={15} />添加 Key</Button></div></div>
                {keys.length ? <div className="key-table"><table><thead><tr><th className="checkbox-cell"><input type="checkbox" aria-label={`选择 ${provider.name} 的全部 Key`} checked={keys.every(k => selected.includes(k.id))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected, ...keys.map(k => k.id)])] : selected.filter(id => !keys.some(k => k.id === id)))} /></th><th>Key / 别名</th><th>剩余额度</th><th>最近变化</th><th>状态</th><th>更新时间</th><th className="actions-cell">操作</th></tr></thead><tbody>{keys.map(key => <tr key={key.id}><td className="checkbox-cell"><input type="checkbox" aria-label={`选择 ${key.name}`} checked={selected.includes(key.id)} onChange={e => setSelected(e.target.checked ? [...selected, key.id] : selected.filter(id => id !== key.id))} /></td><td data-label="Key"><button className="key-name" onClick={() => setDialog({ kind: 'detail', keyId: key.id })}>{key.name}</button><code className="key-mask">{key.mask}</code>{key.tags.length > 0 && <div className="key-tags">{key.tags.map(t => <span key={t}>{t}</span>)}</div>}</td><td data-label="剩余额度"><Balance item={key} /><small className="amount-sub">{key.latest?.scope === 'token' ? 'Key 配额' : key.latest?.scope === 'account' ? '账户余额' : '口径待确认'}</small></td><td data-label="最近变化"><Delta item={key} /></td><td data-label="状态"><KeyStatus item={key} /></td><td data-label="更新时间" className="time-cell">{dateTime(key.latest?.sampledAt)}</td><td className="actions-cell"><button className="icon-button" aria-label={`刷新 ${key.name}`} disabled={!key.enabled || !provider.enabled} onClick={() => void refresh({ ids: [key.id] })}><RefreshCw size={15} /></button><button className="icon-button" aria-label={`编辑 ${key.name}`} onClick={() => setDialog({ kind: 'key', initial: key })}><Pencil size={15} /></button><button className="icon-button" aria-label={`${key.enabled ? '停用' : '启用'} ${key.name}`} onClick={() => void perform(() => api(`/keys/${key.id}`, 'PUT', { ...key, enabled: !key.enabled }), key.enabled ? '已停用，历史仍保留' : '已启用，请刷新额度')}><Power size={15} /></button><button className="icon-button danger-icon" aria-label={`删除 ${key.name}`} onClick={() => setDialog({ kind: 'delete', title: `删除 ${key.name}？`, description: '这个 Key 和它的所有采样、查询历史都会删除，无法撤销。若只想暂停查询，请使用停用。', path: `/keys/${key.id}` })}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div> : <Empty title="还没有 Key" description="添加一个 Key，或者批量导入，开始查询额度。" action="添加 Key" onAction={() => setDialog({ kind: 'key', providerId: provider.id })} />}
              </section>;
            })}
            {data.providers.length > 0 && !filtered.length && (search || filter !== 'all') && <div className="panel"><Empty title="没有匹配的 Key" description="试试其他关键词或切回全部状态。" /></div>}
            <p className="page-footnote">查询类型由供应商统一配置。停用保留历史，删除会移除关联记录。</p></>}
          {page === 'channels' && <><div className="platform-switch" role="group" aria-label="选择消息平台">{(['qq', 'telegram'] as const).map(id => <Button key={id} variant={platform === id ? 'default' : 'outline'} aria-pressed={platform === id} onClick={() => setPlatform(id)}>{id === 'qq' ? 'QQ' : 'Telegram'}</Button>)}</div>{platform === 'qq' && <QQDriver changed={invalidate} />}<div>{data.channels.filter(channel => channel.platform === platform).map(channel => {
            const status = data.statuses[channel.platform]; const qq = channel.platform === 'qq';
            return <section className="panel channel-panel" key={channel.platform}><div className="panel-heading"><div className="channel-title"><span className={`channel-symbol ${qq ? 'qq-symbol' : ''}`}><MessageSquare size={24} /></span><div><h2>{qq ? 'QQ' : 'Telegram'}</h2><p>{qq ? 'SnowLuma · OneBot v11' : 'Bot API · Long polling'}</p></div></div><Badge tone={!channel.enabled ? 'neutral' : status.connected ? 'green' : 'amber'}>{!channel.enabled ? '未启用' : status.connected ? '已连接' : '连接中'}</Badge></div>
              {qq && <div className="driver-strip"><span>OneBot：{!channel.enabled ? '未启用' : status.connected ? '已连接' : '未连接'}</span><span>QQ 账号：{!channel.enabled || status.accountOnline === null ? '状态未知' : status.accountOnline ? '在线' : '未登录 / 离线'}</span></div>}
              {status.error && <div className="inline-error">{status.error}</div>}
              <ChannelForm key={JSON.stringify(channel)} channel={channel} save={input => saved('/channels', 'PUT', input, '平台设置已保存')} test={async () => { await api('/channels/test', 'POST', { platform: channel.platform }); notify('测试消息已发送到已保存的通知目标'); }} /></section>;
          })}</div><section className="panel command-panel"><div><h2>两个平台，一套命令</h2><p>默认返回快照和更新时间。需要实时结果时使用刷新命令。</p></div><div className="commands-grid">{[['/balance', '查看额度快照'], ['/refresh all', '实时刷新全部'], ['/low', '低额度和异常'], ['/status', '服务状态']].map(([command, label]) => <div key={command}><code>{command}</code><span>{label}</span></div>)}</div><p className="form-note">QQ 在上方完成驱动认证和登录，再自动配置连接。Telegram 轮询不需要公网入口。</p></section></>}
          {page === 'settings' && <div className="settings-layout"><div><section className="panel padded-panel"><div className="panel-heading"><div><h2>巡检与提醒</h2><p>减少手动刷新，也避免重复打扰。</p></div></div><SettingsForm key={JSON.stringify(data.settings)} settings={data.settings} save={input => saved('/settings', 'PUT', input)} /></section><section className="panel padded-panel"><div className="panel-heading"><div><h2>备份与恢复</h2><p>保留完整数据，不只保留配置。</p></div></div><BackupPanel restored={async () => { await invalidate(); notify('备份已恢复，消息平台保持停用'); }} /></section></div><section className="panel"><div className="panel-heading"><div><h2>最近查询</h2><p>最多显示最近 100 次任务</p></div></div><TaskLog tasks={data.tasks} names={Object.fromEntries(data.keys.map(k => [k.id, k.name]))} /></section></div>}
        </>}
      </main><footer className="app-footer"><span><Radar size={13} />QuotaRadar</span><span>让每一份额度都有迹可循。</span></footer></div>
    {dialog && data && <Modal title={dialog.kind === 'provider' ? dialog.initial ? '编辑供应商' : '添加供应商' : dialog.kind === 'key' ? dialog.initial ? '编辑 Key' : '添加 Key' : dialog.kind === 'import' ? '批量导入 Key' : dialog.kind === 'delete' ? dialog.title : data.keys.find(k => k.id === dialog.keyId)?.name ?? 'Key 详情'}
      description={dialog.kind === 'provider' ? '同类请求配置一次，Key 自动继承。' : dialog.kind === 'key' ? '为 Key 起一个容易辨认的名字。' : dialog.kind === 'import' ? '先检查，再导入。重复凭据不会重复创建。' : dialog.kind === 'delete' ? dialog.description : '额度快照、变化与查询记录。'} onClose={() => setDialog(null)} wide={dialog.kind === 'detail'}>
      {dialog.kind === 'provider' && <ProviderForm initial={dialog.initial} cancel={() => setDialog(null)} save={input => saved(dialog.initial ? `/providers/${dialog.initial.id}` : '/providers', dialog.initial ? 'PUT' : 'POST', input)} />}
      {dialog.kind === 'key' && <KeyForm initial={dialog.initial} providerId={dialog.providerId} providers={data.providers} cancel={() => setDialog(null)} save={input => saved(dialog.initial ? `/keys/${dialog.initial.id}` : '/keys', dialog.initial ? 'PUT' : 'POST', input)} />}
      {dialog.kind === 'import' && <ImportForm providers={data.providers} providerId={dialog.providerId} cancel={() => setDialog(null)} done={async count => { await invalidate(); setDialog(null); notify(`已导入 ${count} 个 Key`); }} />}
      {dialog.kind === 'detail' && (() => { const key = data.keys.find(k => k.id === dialog.keyId); return key ? <KeyDetail item={key} refreshMinutes={data.settings.refreshMinutes} refresh={() => void refresh({ ids: [key.id] })} /> : <Empty title="这个 Key 已被删除" description="可以关闭详情并查看其他 Key。" />; })()}
      {dialog.kind === 'delete' && <div className="form-actions"><Button variant="outline" onClick={() => setDialog(null)}>取消</Button><Button variant="danger" loading={busy} onClick={() => void perform(async () => { await api(dialog.path, 'DELETE'); setDialog(null); }, '已删除')}><Trash2 size={16} />确认删除</Button></div>}
    </Modal>}
    {notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}<span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button></div>}
  </div>;
}
