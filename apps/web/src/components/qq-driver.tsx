import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, RefreshCw } from 'lucide-react';
import type { DriverSettings, DriverSettingsInput, DriverState, DriverNetwork, DriverLog } from '../../../../packages/shared/driver.ts';
import { api } from '../api.ts';
import { Badge, Button, Check, Field, Modal } from './ui.tsx';
import { FormError } from './forms.tsx';

function DriverAddresses({ settings, save, busy }: { settings: DriverSettings; save: (input: DriverSettingsInput) => Promise<void>; busy: boolean }) {
  const [apiUrl, setApiUrl] = useState(settings.apiUrl), [desktopUrl, setDesktopUrl] = useState(settings.desktopUrl);
  return <form onSubmit={e => { e.preventDefault(); void save({ apiUrl, desktopUrl }); }}><div className="form-grid">
    <Field label="驱动管理地址" hint="后端访问的地址，不是浏览器地址。Docker 使用 http://snowluma:5099/。"><input type="url" required value={apiUrl} onChange={e => setApiUrl(e.target.value)} /></Field>
    <Field label="登录桌面地址" hint="Docker 使用 http://snowluma:6081/；本机运行使用 127.0.0.1。"><input type="url" required value={desktopUrl} onChange={e => setDesktopUrl(e.target.value)} /></Field>
  </div><p className="form-note">更换管理地址会清除已保存的驱动密码，需要重新认证。</p><Button loading={busy} type="submit" variant="outline">保存驱动地址</Button></form>;
}
function DriverLogs() {
  const query = useQuery({ queryKey: ['qq-logs'], queryFn: () => api<{ logs: DriverLog[] }>('/qq/driver/logs'), retry: false, refetchOnWindowFocus: false, refetchOnMount: false, refetchInterval: q => q.state.error ? false : 5000 });
  return <div><div className="driver-actions"><span className="muted">最近 100 条 · 凭据已隐藏</span><Button variant="ghost" loading={query.isFetching} onClick={() => void query.refetch()}>刷新日志</Button></div>
    <FormError error={query.error?.message || ''} /><div className="driver-logs" role="region" aria-label="QQ 驱动日志" tabIndex={0}>{query.isPending ? '正在读取日志…' : query.data?.logs.length ? query.data.logs.map(log => <div key={log.id}><span>{log.time} [{log.level}]</span><pre>{log.message}</pre></div>) : '暂无日志'}</div></div>;
}
function LoginDesktop({ managed }: { managed: boolean }) {
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setReady(false); setLoaded(false); setError('');
    void fetch('/api/qq/desktop/vnc.html', { signal: controller.signal }).then(async response => {
      await response.body?.cancel();
      if (!response.ok) throw new Error(response.status === 401 ? '管理台登录已过期，请关闭窗口重新登录。' : '登录桌面无法连接，请检查驱动是否运行及高级设置中的桌面地址。');
      setReady(true);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [attempt]);
  return <div><p className="form-note">{managed ? '桌面连接由 QuotaRadar 验证，无需额外密码。请在下方 QQ 客户端扫码；关闭窗口不会退出 QQ。' : '在下方 QQ 客户端扫码。外部桌面需要单独配置的 VNC 密码，不是 QuotaRadar 管理密码。'}</p>
    {error ? <><FormError error={error} /><Button variant="outline" onClick={() => setAttempt(v => v + 1)}>重试登录桌面</Button></> : <>
      <p className="form-note" role="status">{loaded ? '桌面页面已加载；连接情况以桌面内提示为准。扫码完成后关闭窗口并刷新 QQ 状态。' : '正在加载登录桌面…'}</p>
      {ready && <iframe key={attempt} className="qq-desktop" title="QQ 登录桌面" src="/api/qq/desktop/vnc.html?autoconnect=true&resize=scale&host=&path=%2Fapi%2Fqq%2Fdesktop%2Fwebsockify" onLoad={() => setLoaded(true)} />}
    </>}</div>;
}
export function QQDriver({ changed }: { changed: () => Promise<void> }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['qq-driver'], queryFn: () => api<DriverState>('/qq/driver'), retry: false, refetchOnWindowFocus: false, refetchOnMount: false,
    refetchInterval: q => q.state.error || !q.state.data?.authenticated || q.state.data.consentRequired || q.state.data.mustChangePassword ? false : 5000 });
  const settings = useQuery({ queryKey: ['qq-driver-settings'], queryFn: () => api<DriverSettings>('/qq/driver/settings'), retry: false, refetchOnWindowFocus: false });
  const [password, setPassword] = useState(''), [newPassword, setNewPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [agreed, setAgreed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [account, setAccount] = useState(''), [network, setNetwork] = useState(-1), [desktop, setDesktop] = useState(false), [logs, setLogs] = useState(false), [advanced, setAdvanced] = useState(false);
  const desktopButton = useRef<HTMLButtonElement>(null);
  const state = query.data, managed = settings.data?.managed ?? state?.settings.managed ?? false;
  const ready = !query.isError && state?.authenticated && !state.consentRequired && !state.mustChangePassword;
  const uin = state?.accounts.some(a => a.uin === account) ? account : state?.accounts[0]?.uin || '';
  const networks = useQuery({ queryKey: ['qq-networks', uin], queryFn: () => api<{ networks: DriverNetwork[] }>(`/qq/driver/networks/${uin}`), enabled: Boolean(ready && uin), retry: false, refetchOnWindowFocus: false });
  const selectedNetwork = networks.data?.networks.some(n => n.index === network) ? network : networks.data?.networks[0]?.index ?? -1;
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); await client.invalidateQueries({ queryKey: ['qq-driver'] }); await client.invalidateQueries({ queryKey: ['qq-driver-settings'] }); await changed(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const refresh = () => { void query.refetch(); if (ready && uin) void networks.refetch(); };
  return <section className="panel channel-panel">
    <div className="panel-heading"><div><h2>QQ 驱动</h2><p>SnowLuma · 在这里认证、登录和连接</p></div><div className="driver-actions"><Badge tone={ready ? 'green' : 'neutral'}>{ready ? '管理已连接' : '待完成连接'}</Badge><Button variant="ghost" loading={query.isFetching} onClick={refresh} aria-label="刷新 QQ 驱动状态"><RefreshCw size={16} /></Button></div></div>
    <div className="driver-actions driver-primary-actions"><button ref={desktopButton} className="button button-outline" onClick={() => setDesktop(true)}><Monitor size={16} />打开 QQ 登录</button><span className="muted">登录桌面只在打开时连接</span></div>
    <FormError error={error || query.error?.message || settings.error?.message || ''} />{notice && <p className="driver-notice" role="status">{notice}</p>}
    {query.isPending && <p className="form-note">正在读取驱动状态…</p>}
    {managed && <p className="form-note">驱动和桌面认证由 QuotaRadar 统一管理，无需额外密码。</p>}
    {!managed && (!state?.authenticated || query.isError) && !query.isPending && <form className="driver-step" onSubmit={e => { e.preventDefault(); void run(async () => { await api('/qq/driver/login', 'POST', { password }); setPassword(''); }); }}>
      <h3>连接 SnowLuma</h3><p className="form-note">先运行项目的 QQ 启动脚本，再填写启动日志中的管理密码。它与 QuotaRadar 管理密码不同。</p>
      <Field label="SnowLuma 管理密码"><input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field><Button type="submit" loading={busy}>认证驱动</Button>
    </form>}
    {!query.isError && state?.authenticated && state.consentRequired && <div className="driver-step"><h3>阅读 SnowLuma 使用协议</h3><p className="form-note">以下为驱动返回的协议原文。确认后才能继续配置。</p>
      {state.documents.map(doc => <details className="agreement-document" key={doc.id} open><summary>{doc.title}</summary><pre tabIndex={0}>{doc.text}</pre></details>)}
      <Check label="我已阅读并同意以上 SnowLuma 协议" checked={agreed} onChange={setAgreed} /><Button loading={busy} disabled={!agreed || !state.documents.length} onClick={() => void run(async () => { await api('/qq/driver/consent', 'POST', { version: state.agreementVersion, confirmed: true }); setAgreed(false); })}>确认协议并继续</Button>
    </div>}
    {managed && state?.mustChangePassword && <p className="form-note" role="alert">驱动仍要求修改初始密码，请使用项目统一启动配置重新启动驱动。</p>}
    {!managed && !query.isError && state?.authenticated && !state.consentRequired && state.mustChangePassword && <form className="driver-step" onSubmit={e => { e.preventDefault(); void run(async () => {
      if (newPassword !== confirmation) throw new Error('两次输入的新密码不一致');
      const result = await api<{ ok: boolean; rules?: { label: string; ok: boolean }[] }>('/qq/driver/password', 'POST', { password: newPassword });
      if (!result.ok) throw new Error(`密码未通过检查：${result.rules?.filter(rule => !rule.ok).map(rule => rule.label).join('；') || '请使用至少 10 位、含大小写字母和特殊符号且无空格的新密码'}`);
      setNewPassword(''); setConfirmation('');
    }); }}><h3>修改驱动初始密码</h3><p className="form-note">新密码由后端加密保存；修改后会自动重新认证。</p><div className="form-grid">
      <Field label="新驱动管理密码"><input type="password" autoComplete="new-password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} /></Field>
      <Field label="再次输入新密码"><input type="password" autoComplete="new-password" required value={confirmation} onChange={e => setConfirmation(e.target.value)} /></Field></div><Button loading={busy} type="submit">更新驱动密码</Button>
    </form>}
    {ready && <><div className="driver-step"><h3>连接 QQ 账号</h3><p className="form-note">自动读取或创建 OneBot 连接，不需要复制 token。完成后在下方设置允许使用者并启用平台。</p>
      {state.accounts.length ? <><div className="form-grid"><Field label="QQ 账号"><select value={uin} onChange={e => { setAccount(e.target.value); setNetwork(-1); }}>{state.accounts.map(a => <option key={a.uin} value={a.uin}>{a.nickname} · {a.uin}</option>)}</select></Field>
        <Field label="OneBot 连接"><select value={selectedNetwork} disabled={!networks.data || networks.isError} onChange={e => setNetwork(Number(e.target.value))}>{networks.data?.networks.length ? networks.data.networks.map(n => <option key={n.index} value={n.index}>{n.name} · {n.port}{n.path}{!n.enabled ? '（将启用）' : ''}</option>) : <option value={-1}>创建默认连接 · 3001</option>}</select></Field></div>
        <FormError error={networks.error?.message || ''} /><Button loading={busy} disabled={!networks.data || networks.isError} onClick={() => void run(async () => { const result = await api<{ reloaded: boolean }>('/qq/driver/connect', 'POST', { uin, index: selectedNetwork }); await client.invalidateQueries({ queryKey: ['qq-networks'] }); setNotice(result.reloaded ? '连接参数已同步。是否在线以下方平台状态为准。' : '连接参数已保存，但驱动没有完成热重载。请完成 QQ 登录后再同步连接。'); })}>自动配置连接</Button>
      </> : <p className="form-note">尚未发现账号。请打开上方 QQ 登录，完成后刷新状态。</p>}
    </div><details className="advanced" onToggle={e => { if (e.target === e.currentTarget) setAdvanced(e.currentTarget.open); }}><summary>高级：进程状态与日志</summary><p className="form-note">加载驱动和刷新状态只操作已有 QQ 进程，不启动或重启 QQ，也不重启容器。</p>
      {state.processes.length ? state.processes.map(p => <div className="driver-process" key={p.pid}><div><strong>{p.name} · {p.uin || `PID ${p.pid}`}</strong><small>{p.loggedIn ? 'QQ 已登录' : 'QQ 未确认登录'} · {p.connected ? '驱动已连接' : '驱动未连接'} · {p.status}</small></div><div className="driver-actions"><Button loading={busy} variant="outline" onClick={() => void run(async () => { await api('/qq/driver/process', 'POST', { pid: p.pid, action: 'load' }); })}>加载驱动</Button><Button loading={busy} variant="ghost" onClick={() => void run(async () => { await api('/qq/driver/process', 'POST', { pid: p.pid, action: 'refresh' }); })}>刷新状态</Button></div></div>) : <p className="form-note">未发现 QQ 进程。</p>}
      <details onToggle={e => setLogs(e.currentTarget.open)}><summary>查看驱动日志</summary>{logs && advanced && <DriverLogs />}</details>
    </details></>}
    {!managed && <details className="advanced"><summary>高级：驱动地址与重新认证</summary>{settings.data && <DriverAddresses key={`${settings.data.apiUrl}:${settings.data.desktopUrl}`} settings={settings.data} busy={busy} save={input => run(async () => { await api('/qq/driver/settings', 'PUT', input); })} />}
      {state?.authenticated && !query.isError && <form className="driver-step" onSubmit={e => { e.preventDefault(); void run(async () => { await api('/qq/driver/login', 'POST', { password }); setPassword(''); }); }}><Field label="重新认证的驱动密码"><input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></Field><Button type="submit" loading={busy} variant="outline">重新认证</Button></form>}
    </details>}
    {desktop && <Modal title="QQ 登录" description="在 QuotaRadar 内完成 QQ 客户端登录。" wide returnFocusRef={desktopButton} onClose={() => { setDesktop(false); void query.refetch(); }}><LoginDesktop managed={managed} /></Modal>}
  </section>;
}
