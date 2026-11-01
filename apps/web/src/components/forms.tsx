import { useState } from 'react';
import type { ReactNode } from 'react';
import type { AdapterType, Channel, ChannelInput, KeyInput, KeyView, Provider, ProviderInput, Settings } from '../../../../packages/shared/types.ts';
import { adapterNames, providerDefaults } from '../../../../packages/shared/types.ts';
import { Button, Check, Field, Badge, SecretInput, Switch } from './ui.tsx';
import type { Tone } from './ui.tsx';
import { api } from '../api.ts';
import { CheckCircle2, FileDown, Upload, Send } from 'lucide-react';
function useSubmit() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return { busy, error, run, setError };
}
function Actions({ busy, cancel, children = '保存' }: { busy: boolean; cancel?: () => void; children?: ReactNode }) {
  return <div className="form-actions">{cancel && <Button type="button" variant="outline" onClick={cancel}>取消</Button>}<Button type="submit" loading={busy}>{children}</Button></div>;
}
export function FormError({ error }: { error: string }) { return error ? <div className="inline-error" role="alert">{error}</div> : null; }
const presets = [
  { name: '鱼汤', baseUrl: 'https://api-666.cc', adapter: 'openai-billing' },
  { name: 'APIFast', baseUrl: 'https://api.apifast.tech', adapter: 'openai-billing' },
  { name: 'TTK', baseUrl: 'https://ai.ttk.life', adapter: 'newapi-cx' },
] as const;
const adapterHints: Record<AdapterType, string> = {
  'openai-billing': '兼容 OpenAI 的 /v1/dashboard/billing 接口，按查询窗口估算余额。',
  'newapi-cx': 'New API 站点的令牌查询页（/api/token/cx），返回准确余额和有效期。',
  'newapi-usage': 'New API 上游的令牌用量接口（/api/usage/token/）。',
};
export function ProviderForm({ initial, save, cancel }: { initial?: ProviderInput; save: (input: ProviderInput) => Promise<void>; cancel: () => void }) {
  const [value, set] = useState<ProviderInput>(initial ?? providerDefaults());
  const [headers, setHeaders] = useState(Object.keys(initial?.headers ?? {}).length ? JSON.stringify(initial?.headers, null, 2) : '');
  const submit = useSubmit();
  const patch = (change: Partial<ProviderInput>) => set(old => ({ ...old, ...change }));
  const billing = value.adapter === 'openai-billing';
  return <form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(headers.trim() || '{}'); } catch { throw new Error('附加请求头必须是 JSON 对象，例如 {"X-Client": "QuotaRadar"}'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== 'string')) throw new Error('附加请求头必须是值为字符串的 JSON 对象');
    await save({ ...value, name: value.name.trim(), baseUrl: value.baseUrl.trim(), headers: parsed as Record<string, string> });
  }); }}>
    {!initial && <div className="presets"><span>常用站点</span>{presets.map(p => <button key={p.name} type="button" className={value.baseUrl === p.baseUrl ? 'chip active' : 'chip'} onClick={() => patch({ ...p, paths: {}, unit: 'USD' })}>{p.name}</button>)}</div>}
    <div className="form-grid">
      <Field label="名称"><input required maxLength={100} value={value.name} placeholder="例如：工作主站" onChange={e => patch({ name: e.target.value })} /></Field>
      <Field label="查询类型"><select value={value.adapter} onChange={e => patch({ adapter: e.target.value as AdapterType, paths: {}, unit: 'USD' })}>{Object.entries(adapterNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
      <Field wide label="站点地址" hint={adapterHints[value.adapter]}><input type="url" required value={value.baseUrl} placeholder="https://api.example.com" onChange={e => patch({ baseUrl: e.target.value })} /></Field>
      <Field label="余额归属" hint="选“暂不确定”时不计入总额。"><select value={value.scope} onChange={e => patch({ scope: e.target.value as ProviderInput['scope'] })}><option value="unknown">暂不确定</option><option value="token">每个 Key 独立配额</option><option value="account">整个账户共用余额</option></select></Field>
      {!billing && <Field label="显示单位"><input required maxLength={12} value={value.unit} onChange={e => patch({ unit: e.target.value })} /></Field>}
    </div>
    {billing && <Check label="已确认查询窗口内的用量就是全部用量" checked={value.billingWindowConfirmed} onChange={v => patch({ billingWindowConfirmed: v })} hint="不勾选时余额标为“估算”，不计入总额。" />}
    <details className="advanced"><summary>高级设置</summary><div className="form-grid">
      {!billing ? <><Field label="内部单位换算" hint="多少内部单位等于 1 个显示单位。New API 默认 500000。"><input required value={value.unitsPerDollar} onChange={e => patch({ unitsPerDollar: e.target.value })} /></Field>
        <Field label="查询路径"><input value={value.paths.quota ?? ''} placeholder={value.adapter === 'newapi-cx' ? '/api/token/cx' : '/api/usage/token/'} onChange={e => patch({ paths: e.target.value ? { quota: e.target.value } : {} })} /></Field></>
        : <><Field label="查询窗口（天）"><input required type="number" min={1} max={3660} value={value.windowDays} onChange={e => patch({ windowDays: Number(e.target.value) })} /></Field>
          <Field label="总额度路径"><input value={value.paths.subscription ?? ''} placeholder="/v1/dashboard/billing/subscription" onChange={e => patch({ paths: { ...value.paths, subscription: e.target.value || undefined } })} /></Field>
          <Field label="用量路径"><input value={value.paths.usage ?? ''} placeholder="/v1/dashboard/billing/usage" onChange={e => patch({ paths: { ...value.paths, usage: e.target.value || undefined } })} /></Field></>}
      <Field label="请求超时（毫秒）"><input type="number" required min={1000} max={60000} step={1000} value={value.timeoutMs} onChange={e => patch({ timeoutMs: Number(e.target.value) })} /></Field>
      <Field wide label="附加请求头（JSON，可留空）"><textarea rows={3} className="mono" value={headers} placeholder={'{"X-Client": "QuotaRadar"}'} onChange={e => setHeaders(e.target.value)} /></Field>
    </div></details>
    <Switch label="启用" hint="停用后不再自动查询，历史保留。" checked={value.enabled} onChange={v => patch({ enabled: v })} />
    <FormError error={submit.error} /><Actions busy={submit.busy} cancel={cancel}>{initial ? '保存' : '添加供应商'}</Actions>
  </form>;
}
export function KeyForm({ initial, providers, providerId, save, cancel }: { initial?: KeyView; providers: Provider[]; providerId?: string; save: (input: KeyInput) => Promise<void>; cancel: () => void }) {
  const [value, set] = useState<KeyInput>(initial ? { providerId: initial.providerId, name: initial.name, enabled: initial.enabled, tags: initial.tags, threshold: initial.threshold, aggregation: initial.aggregation, balanceGroup: initial.balanceGroup }
    : { providerId: providerId ?? providers[0]?.id ?? '', name: '', secret: '', enabled: true, tags: [], threshold: null, aggregation: 'excluded', balanceGroup: '' });
  const [tags, setTags] = useState(value.tags.join(', ')), submit = useSubmit();
  const patch = (change: Partial<KeyInput>) => set(old => ({ ...old, ...change }));
  const tagList = [...new Set(tags.split(/[,，]/).map(v => v.trim()).filter(Boolean))];
  return <form onSubmit={e => { e.preventDefault(); void submit.run(() => save({ ...value, tags: tagList, threshold: value.threshold?.trim() || null, secret: value.secret?.trim() || undefined })); }}><div className="form-grid">
    <Field label="别名"><input autoFocus required maxLength={100} value={value.name} placeholder="例如：日常主用" onChange={e => patch({ name: e.target.value })} /></Field>
    <Field label="供应商"><select required value={value.providerId} onChange={e => patch({ providerId: e.target.value })}>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    <Field wide label={initial ? '替换 Key' : 'API Key'} hint={initial ? `当前 ${initial.mask}，留空保留。` : '加密保存在服务器，界面和 Bot 只显示掩码。'}><SecretInput label="Key" required={!initial} value={value.secret ?? ''} placeholder={initial ? '留空保留当前 Key' : 'sk-...'} onChange={secret => patch({ secret })} /></Field>
  </div>
    <details className="advanced" open={Boolean(initial && (initial.threshold || initial.tags.length || initial.aggregation !== 'excluded'))}><summary>提醒与汇总</summary><div className="form-grid">
      <Field label="低额度阈值" hint="留空使用设置里的默认值。"><input value={value.threshold ?? ''} inputMode="decimal" placeholder="使用默认值" onChange={e => patch({ threshold: e.target.value || null })} /></Field>
      <Field label="标签" hint="逗号分隔，用于搜索。"><input value={tags} onChange={e => setTags(e.target.value)} placeholder="工作, 备用" /></Field>
      <Field label="计入总额"><select value={value.aggregation} onChange={e => patch({ aggregation: e.target.value as KeyInput['aggregation'] })}><option value="excluded">不计入（默认）</option><option value="independent">计入，这是独立余额</option><option value="shared">计入，与其他 Key 共用一份余额</option></select></Field>
      {value.aggregation === 'shared' && <Field label="共用分组" hint="同组只计一次。"><input required value={value.balanceGroup} placeholder="例如：主账户" onChange={e => patch({ balanceGroup: e.target.value })} /></Field>}
    </div></details>
    <Switch label="自动查询" checked={value.enabled} onChange={v => patch({ enabled: v })} />
    <FormError error={submit.error} /><Actions busy={submit.busy} cancel={cancel}>{initial ? '保存' : '添加并查询'}</Actions></form>;
}
interface Preview { rows: { index: number; name: string; mask: string; duplicate: boolean }[]; added: number }
export function ImportForm({ providers, done, cancel, providerId }: { providers: Provider[]; done: (count: number) => Promise<void>; cancel: () => void; providerId?: string }) {
  const [selected, setSelected] = useState(providerId ?? providers[0]?.id ?? ''), [text, setText] = useState(''), [preview, setPreview] = useState<Preview | null>(null);
  const [prefix, setPrefix] = useState('Key');
  const submit = useSubmit();
  const payload = () => ({ providerId: selected, rows: text.split('\n').map(s => s.trim()).filter(Boolean).map((line, index) => {
    const split = line.search(/[|\t]/);
    return split > 0 ? { name: line.slice(0, split).trim(), secret: line.slice(split + 1).trim() } : { name: `${prefix.trim() || 'Key'} ${index + 1}`, secret: line };
  }) });
  const fresh = preview?.rows.filter(r => !r.duplicate).length ?? 0;
  return <form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
    if (!preview) setPreview(await api<Preview>('/keys/import', 'POST', { ...payload(), preview: true }));
    else { const result = await api<Preview>('/keys/import', 'POST', { ...payload(), preview: false }); await done(result.added); }
  }); }}><div className="form-grid"><Field label="供应商"><select value={selected} onChange={e => { setSelected(e.target.value); setPreview(null); }}>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    <Field label="默认别名前缀"><input maxLength={80} value={prefix} onChange={e => { setPrefix(e.target.value); setPreview(null); }} /></Field></div>
    <Field label="Key 列表" hint="每行一个，可写成“别名 | Key”，也可直接粘贴表格两列。最多 500 行。"><textarea autoComplete="off" spellCheck={false} required rows={7} value={text} onChange={e => { setText(e.target.value); setPreview(null); }} placeholder={'日常主用 | sk-...\n备用 | sk-...'} className="mono" /></Field>
    {preview && <div className="import-preview"><p><CheckCircle2 size={16} />{fresh} 个新 Key{preview.rows.length > fresh && `，${preview.rows.length - fresh} 个重复将跳过`}</p>{preview.rows.map(row => <div key={row.index}><span>{row.name}</span><code>{row.mask}</code><Badge tone={row.duplicate ? 'amber' : 'green'}>{row.duplicate ? '重复' : '新增'}</Badge></div>)}</div>}
    <FormError error={submit.error} /><Actions busy={submit.busy} cancel={cancel}>{preview ? `导入 ${fresh} 个并查询` : '检查'}</Actions></form>;
}
function list(text: string): string[] { return text.split(/[\s,，]+/).map(s => s.trim()).filter(Boolean); }
type TestResult = { kind: 'private' | 'group'; id: string; state: 'sent' | 'unconfirmed' | 'failed'; error: string | null };
const testLabels: Record<TestResult['state'], { label: string; tone: Tone }> = { sent: { label: '已送达', tone: 'green' }, unconfirmed: { label: '已提交', tone: 'green' }, failed: { label: '失败', tone: 'red' } };
export function ChannelForm({ channel, save }: { channel: Channel; save: (input: ChannelInput) => Promise<void> }) {
  const qq = channel.platform === 'qq';
  const [value, set] = useState<ChannelInput>({ ...channel, token: undefined });
  const [users, setUsers] = useState(channel.allowedUsers.join('\n')), [groups, setGroups] = useState(channel.allowedGroups.join('\n'));
  const [privateTargets, setPrivate] = useState(channel.targets.filter(t => t.kind === 'private').map(t => t.id).join('\n'));
  const [groupTargets, setGroupTargets] = useState(channel.targets.filter(t => t.kind === 'group').map(t => t.id).join('\n'));
  const [token, setToken] = useState(''), [clearToken, setClear] = useState(false), submit = useSubmit();
  const [results, setResults] = useState<TestResult[] | null>(null), [testing, setTesting] = useState(false);
  const patch = (change: Partial<ChannelInput>) => set(old => ({ ...old, ...change }));
  const targets = () => [...list(privateTargets).map(id => ({ kind: 'private' as const, id })), ...list(groupTargets).map(id => ({ kind: 'group' as const, id }))];
  const test = async () => {
    setTesting(true); setResults(null); submit.setError('');
    try { setResults((await api<{ results: TestResult[] }>('/channels/test', 'POST', { platform: channel.platform })).results); }
    catch (e) { submit.setError((e as Error).message); } finally { setTesting(false); }
  };
  return <form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
    const all = targets();
    if (all.some(t => !/^-?\d+$/.test(t.id))) throw new Error('ID 只能是数字，多个用换行或逗号分隔');
    await save({ ...value, token: clearToken ? '' : token || undefined, allowedUsers: list(users), allowedGroups: list(groups), targets: all }); setToken('');
  }); }}>
    {!qq && <Field label="Bot Token" hint={channel.hasToken ? '已保存，留空保留。' : '从 @BotFather 获取。'}><SecretInput label="Token" value={token} onChange={setToken} placeholder={channel.hasToken ? '已保存' : '123456:ABC...'} /></Field>}
    <div className="form-grid">
      <Field label="谁可以使用命令" hint="个人 ID，每行一个。群里也会检查发送者。"><textarea required={value.enabled} rows={3} value={users} onChange={e => setUsers(e.target.value)} /></Field>
      <Field label="允许的群" hint={qq ? '群号，每行一个。' : '群 ID 通常是负数。'}><textarea rows={3} value={groups} onChange={e => setGroups(e.target.value)} /></Field>
      <Field label="提醒发给个人" hint={qq ? 'QQ 号，每行一个。' : '需先私聊 Bot 一次。'}><textarea rows={2} value={privateTargets} onChange={e => setPrivate(e.target.value)} /></Field>
      <Field label="提醒发到群"><textarea rows={2} value={groupTargets} onChange={e => setGroupTargets(e.target.value)} /></Field>
    </div>
    {qq && <details className="advanced"><summary>手动 OneBot 连接</summary><p className="form-note">通常由上方“自动配置连接”填写，无需改动。</p><div className="form-grid">
      <Field wide label="WebSocket 地址"><input required type="url" value={value.endpoint} onChange={e => patch({ endpoint: e.target.value })} /></Field>
      <Field wide label="Access Token" hint={channel.hasToken ? '已保存，留空保留。' : undefined}><SecretInput label="Token" value={token} onChange={setToken} placeholder={channel.hasToken ? '已保存' : ''} /></Field>
    </div>{channel.hasToken && <Check label="清除已保存的 token" checked={clearToken} onChange={setClear} />}</details>}
    <Switch label={`启用 ${qq ? 'QQ' : 'Telegram'} Bot`} hint="启用后响应命令并发送提醒。" checked={value.enabled} onChange={v => patch({ enabled: v })} />
    {results && <div className="test-results" role="status">{results.map(r => <div key={`${r.kind}:${r.id}`}><span>{r.kind === 'group' ? '群' : '个人'} {r.id}</span>{r.error && r.state === 'failed' && <small>{r.error}</small>}<Badge tone={testLabels[r.state].tone}>{testLabels[r.state].label}</Badge></div>)}
      {results.some(r => r.state === 'unconfirmed') && <p>“已提交”表示消息已交给 QQ，但 QQ 服务器没有及时确认，通常已经送达。</p>}</div>}
    <FormError error={submit.error} /><div className="form-actions"><Button type="button" variant="outline" loading={testing} disabled={!channel.enabled || !channel.targets.length || submit.busy} title={!channel.enabled ? '保存并启用后可测试' : undefined} onClick={() => void test()}><Send size={15} />发送测试</Button><Button type="submit" loading={submit.busy}>保存</Button></div>
  </form>;
}
export function SettingsForm({ settings, save }: { settings: Settings; save: (input: Settings) => Promise<void> }) {
  const [value, set] = useState(settings), submit = useSubmit();
  const patch = (change: Partial<Settings>) => set(old => ({ ...old, ...change }));
  return <form onSubmit={e => { e.preventDefault(); void submit.run(() => save(value)); }}>
    <h3 className="form-section">巡检</h3><div className="form-grid">
      <Field label="自动刷新间隔（分钟）"><input type="number" min={1} max={1440} required value={value.refreshMinutes} onChange={e => patch({ refreshMinutes: Number(e.target.value) })} /></Field>
      <Field label="默认低额度阈值" hint="按各 Key 的显示单位比较。"><input required inputMode="decimal" value={value.defaultThreshold} onChange={e => patch({ defaultThreshold: e.target.value })} /></Field>
    </div>
    <h3 className="form-section">提醒</h3><div className="form-grid">
      <Field label="连续失败几次后提醒"><input type="number" min={1} max={20} required value={value.failureThreshold} onChange={e => patch({ failureThreshold: Number(e.target.value) })} /></Field>
      <Field label="异常重复提醒（小时）" hint="低额度只提醒一次，恢复后再跌破才会再提醒。"><input type="number" min={1} max={168} required value={value.reminderHours} onChange={e => patch({ reminderHours: Number(e.target.value) })} /></Field>
    </div>
    <Switch label="每日摘要" hint="每天定时把所有 Key 的余额发到通知目标。" checked={value.dailyEnabled} onChange={v => patch({ dailyEnabled: v })} />
    {value.dailyEnabled && <div className="form-grid"><Field label="发送时间"><input type="time" required value={value.dailyTime} onChange={e => patch({ dailyTime: e.target.value })} /></Field>
      <Field label="时区"><input required list="timezones" value={value.timezone} onChange={e => patch({ timezone: e.target.value })} placeholder="Asia/Shanghai" /></Field></div>}
    <details className="advanced"><summary>数据保留与时区</summary><div className="form-grid">
      <Field label="采样历史保留（天）"><input type="number" min={1} max={3650} required value={value.snapshotDays} onChange={e => patch({ snapshotDays: Number(e.target.value) })} /></Field>
      <Field label="查询与通知记录保留（天）"><input type="number" min={1} max={365} required value={value.taskDays} onChange={e => patch({ taskDays: Number(e.target.value) })} /></Field>
      {!value.dailyEnabled && <Field label="时区" hint="用于 Bot 消息里的时间。"><input required list="timezones" value={value.timezone} onChange={e => patch({ timezone: e.target.value })} placeholder="Asia/Shanghai" /></Field>}
    </div></details>
    <datalist id="timezones">{['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC'].map(zone => <option key={zone} value={zone} />)}</datalist>
    <FormError error={submit.error} /><Actions busy={submit.busy} /></form>;
}
export function BackupPanel({ restored }: { restored: () => Promise<void> }) {
  const [password, setPassword] = useState(''), [file, setFile] = useState<File | null>(null), [confirmation, setConfirmation] = useState(''), submit = useSubmit();
  return <div><p className="form-note">备份包含全部配置、Key 和历史，用口令加密。不含 QQ 登录状态和管理员密码。</p>
    <Field label="备份口令" hint="至少 10 位，恢复时需要同一口令。"><SecretInput label="口令" value={password} onChange={setPassword} /></Field>
    <Button variant="outline" loading={submit.busy} disabled={password.length < 10} onClick={() => void submit.run(async () => {
      const backup = await api<{ filename: string; content: string }>('/backup', 'POST', { password });
      const url = URL.createObjectURL(new Blob([backup.content], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = backup.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    })}><FileDown size={16} />下载备份</Button>
    <details className="advanced"><summary>从备份恢复</summary><p className="form-note">恢复会覆盖当前所有数据，并停用 QQ 和 Telegram，核对后再手动启用。</p>
      <Field label="备份文件"><input type="file" accept=".qrb,application/json" onChange={e => setFile(e.target.files?.[0] ?? null)} /></Field>
      <Field label="输入“恢复并覆盖”确认"><input value={confirmation} onChange={e => setConfirmation(e.target.value)} /></Field>
      <Button variant="danger" disabled={!file || password.length < 10 || confirmation !== '恢复并覆盖'} loading={submit.busy} onClick={() => void submit.run(async () => {
        if (!file) return; await api('/restore', 'POST', { password, content: await file.text(), confirmation }); await restored(); setConfirmation('');
      })}><Upload size={16} />恢复</Button></details><FormError error={submit.error} />
  </div>;
}
