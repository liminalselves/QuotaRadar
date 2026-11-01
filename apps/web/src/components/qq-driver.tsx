import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check as CheckIcon, Monitor, RefreshCw } from 'lucide-react';
import type { DriverSettings, DriverSettingsInput, DriverState, DriverNetwork, DriverLog } from '../../../../packages/shared/driver.ts';
import { api } from '../api.ts';
import { Badge, Button, Check, Field, Modal } from './ui.tsx';
import { FormError } from './forms.tsx';

function DriverAddresses({ settings, save, busy }: { settings: DriverSettings; save: (input: DriverSettingsInput) => Promise<void>; busy: boolean }) {
  const [apiUrl, setApiUrl] = useState(settings.apiUrl), [desktopUrl, setDesktopUrl] = useState(settings.desktopUrl);
  return <form onSubmit={e => { e.preventDefault(); void save({ apiUrl, desktopUrl }); }}><div className="form-grid">
    <Field label="驱动管理地址" hint="后端访问的地址。Docker 使用 http://snowluma:5099/。"><input type="url" required value={apiUrl} onChange={e => setApiUrl(e.target.value)} /></Field>
    <Field label="登录桌面地址" hint="Docker 使用 http://snowluma:6081/。"><input type="url" required value={desktopUrl} onChange={e => setDesktopUrl(e.target.value)} /></Field>
  </div><p className="form-note">更换管理地址后需要重新认证。</p><Button loading={busy} type="submit" variant="outline">保存地址</Button></form>;
}
function DriverLogs() {
  const query = useQuery({ queryKey: ['qq-logs'], queryFn: () => api<{ logs: DriverLog[] }>('/qq/driver/logs'), retry: false, refetchOnWindowFocus: false, refetchOnMount: false, refetchInterval: q => q.state.error ? false : 5000 });
  return <div><div className="driver-actions"><span className="muted">最近 100 条，凭据已隐藏</span><Button variant="ghost" loading={query.isFetching} onClick={() => void query.refetch()}>刷新</Button></div>
    <FormError error={query.error?.message || ''} /><div className="driver-logs" role="region" aria-label="QQ 驱动日志" tabIndex={0}>{query.isPending ? '正在读取…' : query.data?.logs.length ? query.data.logs.map(log => <div key={log.id}><span>{log.time} [{log.level}]</span><pre>{log.message}</pre></div>) : '暂无日志'}</div></div>;
}
function LoginDesktop({ managed }: { managed: boolean }) {
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setReady(false); setLoaded(false); setError('');
    void fetch('/api/qq/desktop/vnc.html', { signal: controller.signal }).then(async response => {
      await response.body?.cancel();
      if (!response.ok) throw new Error(response.status === 401 ? '管理台登录已过期，请关闭窗口重新登录。' : '登录桌面无法连接，请检查驱动是否运行。');
      setReady(true);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [attempt]);
  return <div><p className="form-note">{managed ? '用手机 QQ 扫描下方二维码。关闭窗口不会退出 QQ。' : '用手机 QQ 扫描下方二维码。外部桌面需要单独的 VNC 密码。'}</p>
    {error ? <><FormError error={error} /><Button variant="outline" onClick={() => setAttempt(v => v + 1)}>重试</Button></> : <>
      {!loaded && <p className="form-note" role="status">正在加载登录桌面…</p>}
      {ready && <iframe key={attempt} className="qq-desktop" title="QQ 登录桌面" src="/api/qq/desktop/vnc.html?autoconnect=true&resize=scale&host=&path=%2Fapi%2Fqq%2Fdesktop%2Fwebsockify" onLoad={() => setLoaded(true)} />}
    </>}</div>;
}
function Step({ index, title, done, active, children }: { index: number; title: string; done: boolean; active: boolean; children?: ReactNode }) {
  return <li className={`step ${done ? 'step-done' : ''} ${active ? 'step-active' : ''}`}><span className="step-mark">{done ? <CheckIcon size={13} /> : index}</span><div><h3>{title}</h3>{active && children}</div></li>;
}
export function QQDriver({ changed, connected }: { changed: () => Promise<void>; connected: boolean }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['qq-driver'], queryFn: () => api<DriverState>('/qq/driver'), retry: false, refetchOnWindowFocus: false,
    refetchInterval: q => q.state.error || !q.state.data?.authenticated || q.state.data.consentRequired || q.state.data.mustChangePassword ? false : 5000 });
  const settings = useQuery({ queryKey: ['qq-driver-settings'], queryFn: () => api<DriverSettings>('/qq/driver/settings'), retry: false, refetchOnWindowFocus: false });
  const [password, setPassword] = useState(''), [newPassword, setNewPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [agreed, setAgreed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [account, setAccount] = useState(''), [network, setNetwork] = useState(-1), [desktop, setDesktop] = useState(false), [logs, setLogs] = useState(false);
  const desktopButton = useRef<HTMLButtonElement>(null);
  const state = query.data, managed = settings.data?.managed ?? state?.settings.managed ?? false;
  const authed = Boolean(!query.isError && state?.authenticated);
  const ready = authed && !state!.consentRequired && !state!.mustChangePassword;
  const loggedIn = ready && Boolean(state!.accounts.length);
  const uin = state?.accounts.some(a => a.uin === account) ? account : state?.accounts[0]?.uin || '';
  const networks = useQuery({ queryKey: ['qq-networks', uin], queryFn: () => api<{ networks: DriverNetwork[] }>(`/qq/driver/networks/${uin}`), enabled: Boolean(ready && uin), retry: false, refetchOnWindowFocus: false });
  const selectedNetwork = networks.data?.networks.some(n => n.index === network) ? network : networks.data?.networks[0]?.index ?? -1;
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); await client.invalidateQueries({ queryKey: ['qq-driver'] }); await client.invalidateQueries({ queryKey: ['qq-driver-settings'] }); await changed(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const login = <form className="inline-form" onSubmit={e => { e.preventDefault(); void run(async () => { await api('/qq/driver/login', 'POST', { password }); setPassword(''); }); }}>
    <Field label="SnowLuma 管理密码" hint="见驱动首次启动日志，与 QuotaRadar 密码不同。"><input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field><Button type="submit" loading={busy}>认证</Button></form>;
  const step = !authed ? 1 : state!.consentRequired || state!.mustChangePassword ? 1 : !loggedIn ? 2 : 3;
  return <section className="panel padded-panel">
    <div className="panel-heading"><div><h2>QQ 账号</h2><p>SnowLuma 驱动</p></div><div className="driver-actions">
      <Badge tone={loggedIn ? 'green' : 'neutral'}>{query.isPending ? '读取中' : loggedIn ? `${state!.accounts[0].nickname} 已登录` : authed ? '未登录' : '驱动未连接'}</Badge>
      <Button variant="ghost" loading={query.isFetching} onClick={() => { void query.refetch(); if (ready && uin) void networks.refetch(); }} aria-label="刷新 QQ 状态"><RefreshCw size={15} /></Button></div></div>
    <FormError error={error || query.error?.message || settings.error?.message || ''} />{notice && <p className="driver-notice" role="status">{notice}</p>}
    {!query.isPending && <ol className="steps">
      <Step index={1} title={state?.consentRequired ? '阅读并同意驱动协议' : state?.mustChangePassword ? '修改驱动初始密码' : '连接驱动'} done={step > 1} active={step === 1}>
        {!authed && (managed ? <p className="form-note">驱动认证由 QuotaRadar 自动完成。如果长时间未连接，请检查 SnowLuma 容器是否运行。</p> : login)}
        {authed && state!.consentRequired && <><p className="form-note">以下是驱动返回的协议原文，确认后才能继续。</p>
          {state!.documents.map(doc => <details className="agreement-document" key={doc.id} open><summary>{doc.title}</summary><pre tabIndex={0}>{doc.text}</pre></details>)}
          <Check label="我已阅读并同意以上协议" checked={agreed} onChange={setAgreed} /><Button loading={busy} disabled={!agreed || !state!.documents.length} onClick={() => void run(async () => { await api('/qq/driver/consent', 'POST', { version: state!.agreementVersion, confirmed: true }); setAgreed(false); })}>同意并继续</Button></>}
        {authed && !state!.consentRequired && state!.mustChangePassword && (managed ? <p className="form-note" role="alert">驱动仍要求修改初始密码，请使用项目的统一启动配置重启驱动。</p>
          : <form onSubmit={e => { e.preventDefault(); void run(async () => {
            if (newPassword !== confirmation) throw new Error('两次输入的密码不一致');
            const result = await api<{ ok: boolean; rules?: { label: string; ok: boolean }[] }>('/qq/driver/password', 'POST', { password: newPassword });
            if (!result.ok) throw new Error(`密码未通过检查：${result.rules?.filter(rule => !rule.ok).map(rule => rule.label).join('；') || '至少 10 位，含大小写字母和特殊符号，无空格'}`);
            setNewPassword(''); setConfirmation('');
          }); }}><div className="form-grid"><Field label="新密码"><input type="password" autoComplete="new-password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} /></Field>
            <Field label="确认新密码"><input type="password" autoComplete="new-password" required value={confirmation} onChange={e => setConfirmation(e.target.value)} /></Field></div><Button loading={busy} type="submit">更新密码</Button></form>)}
      </Step>
      <Step index={2} title="扫码登录 QQ" done={step > 2} active={step === 2}>
        <p className="form-note">打开登录桌面，用手机 QQ 扫码。完成后点右上角刷新。</p>
        <button ref={desktopButton} className="button button-default" onClick={() => setDesktop(true)}><Monitor size={15} />打开登录桌面</button>
      </Step>
      <Step index={3} title="连接 Bot" done={loggedIn && connected} active={step === 3}>
        {loggedIn && <><div className="form-grid">{state!.accounts.length > 1 && <Field label="QQ 账号"><select value={uin} onChange={e => { setAccount(e.target.value); setNetwork(-1); }}>{state!.accounts.map(a => <option key={a.uin} value={a.uin}>{a.nickname} · {a.uin}</option>)}</select></Field>}
          {(networks.data?.networks.length ?? 0) > 1 && <Field label="OneBot 连接"><select value={selectedNetwork} onChange={e => setNetwork(Number(e.target.value))}>{networks.data!.networks.map(n => <option key={n.index} value={n.index}>{n.name} · {n.port}{n.path}{!n.enabled ? '（将启用）' : ''}</option>)}</select></Field>}</div>
          <FormError error={networks.error?.message || ''} />
          <p className="form-note">{connected ? '已连接。重新登录或更换账号后可再次同步。' : '自动创建 OneBot 连接，无需复制 token。完成后在下方设置使用者并启用 Bot。'}</p>
          <Button loading={busy} variant={connected ? 'outline' : 'default'} disabled={!networks.data || networks.isError} onClick={() => void run(async () => { const result = await api<{ reloaded: boolean }>('/qq/driver/connect', 'POST', { uin, index: selectedNetwork }); await client.invalidateQueries({ queryKey: ['qq-networks'] }); setNotice(result.reloaded ? '连接已同步。' : '连接参数已保存，但驱动没有热重载；请确认 QQ 已登录后重试。'); })}>{connected ? '重新同步连接' : '自动配置连接'}</Button></>}
      </Step>
    </ol>}
    {(ready || !managed) && <details className="advanced"><summary>高级</summary>
      {ready && <>{loggedIn && <p className="form-note"><button className="link-button" onClick={() => setDesktop(true)}>打开登录桌面</button>（切换账号或重新扫码）</p>}
        {state!.processes.length ? state!.processes.map(p => <div className="driver-process" key={p.pid}><div><strong>{p.name} · {p.uin || `PID ${p.pid}`}</strong><small>{p.loggedIn ? '已登录' : '未登录'} · {p.connected ? '驱动已加载' : '驱动未加载'} · {p.status}</small></div><div className="driver-actions"><Button loading={busy} variant="outline" onClick={() => void run(async () => { await api('/qq/driver/process', 'POST', { pid: p.pid, action: 'load' }); })}>加载驱动</Button><Button loading={busy} variant="ghost" onClick={() => void run(async () => { await api('/qq/driver/process', 'POST', { pid: p.pid, action: 'refresh' }); })}>刷新</Button></div></div>) : <p className="form-note">未发现 QQ 进程。</p>}
        <details onToggle={e => setLogs(e.currentTarget.open)}><summary>驱动日志</summary>{logs && <DriverLogs />}</details></>}
      {!managed && <><h3 className="form-section">驱动地址</h3>{settings.data && <DriverAddresses key={`${settings.data.apiUrl}:${settings.data.desktopUrl}`} settings={settings.data} busy={busy} save={input => run(async () => { await api('/qq/driver/settings', 'PUT', input); })} />}
        {authed && <><h3 className="form-section">重新认证</h3>{login}</>}</>}
    </details>}
    {desktop && <Modal title="QQ 登录" wide returnFocusRef={desktopButton} onClose={() => { setDesktop(false); void query.refetch(); }}><LoginDesktop managed={managed} /></Modal>}
  </section>;
}
