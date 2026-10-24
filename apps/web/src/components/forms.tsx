import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AdapterType, Channel, ChannelInput, KeyInput, KeyView, Provider, ProviderInput, Settings } from '../../../../packages/shared/types.ts';
import { adapterNames, providerDefaults } from '../../../../packages/shared/types.ts';
import { Button, Check, Field, Badge } from './ui.tsx';
import { api } from '../api.ts';
import { CheckCircle2, FileDown, Upload, Eye, EyeOff } from 'lucide-react';
function useSubmit() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return { busy, error, run };
}
function Actions({ busy, cancel, children = '保存设置' }: { busy: boolean; cancel?: () => void; children?: ReactNode }) {
  return <div className="form-actions">{cancel && <Button type="button" variant="outline" onClick={cancel}>取消</Button>}<Button type="submit" loading={busy}>{children}</Button></div>;
}
export function FormError({ error }: { error: string }) { return error ? <div className="inline-error" role="alert">{error}</div> : null; }
export function ProviderForm({ initial, save, cancel }: { initial?: ProviderInput; save: (input: ProviderInput) => Promise<void>; cancel: () => void }) {
  const [value, set] = useState<ProviderInput>(initial ?? providerDefaults());
  const [headers, setHeaders] = useState(JSON.stringify(initial?.headers ?? {}, null, 2));
  const submit = useSubmit();
  const patch = (change: Partial<ProviderInput>) => set(old => ({ ...old, ...change }));
  return <form onSubmit={e => { e.preventDefault(); void submit.run(async () => { await save({ ...value, headers: JSON.parse(headers) }); }); }}>
    {!initial && <div className="presets"><span>快速填入</span>{[
      { name: '鱼汤', baseUrl: 'https://api-666.cc', adapter: 'openai-billing' },
      { name: 'APIFast', baseUrl: 'https://api.apifast.tech', adapter: 'openai-billing' },
      { name: 'TTK', baseUrl: 'https://ai.ttk.life', adapter: 'newapi-cx' },
    ].map(p => <Button key={p.name} type="button" variant="outline" onClick={() => patch({ ...p, adapter: p.adapter as AdapterType })}>{p.name}</Button>)}</div>}
    <div className="form-grid">
      <Field label="供应商名称"><input required maxLength={100} value={value.name} placeholder="例如：工作主站" onChange={e => patch({ name: e.target.value })} /></Field>
      <Field label="查询类型"><select value={value.adapter} onChange={e => patch({ adapter: e.target.value as AdapterType, paths: {}, unit: 'USD' })}>{Object.entries(adapterNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
      <Field wide label="站点 URL" hint="只填站点地址；支持路径前缀，不要填完整查询接口。"><input type="url" required value={value.baseUrl} placeholder="https://api.example.com" onChange={e => patch({ baseUrl: e.target.value })} /></Field>
      <Field label="额度范围" hint="未知范围不参与合计。"><select value={value.scope} onChange={e => patch({ scope: e.target.value as ProviderInput['scope'] })}><option value="unknown">暂不确定</option><option value="token">Key 配额</option><option value="account">账户余额</option></select></Field>
      <Field label="显示单位"><input required maxLength={12} disabled={value.adapter === 'openai-billing'} value={value.unit} onChange={e => patch({ unit: e.target.value })} /></Field>
    </div>
    <details className="advanced"><summary>高级请求设置</summary><div className="form-grid">
      {value.adapter !== 'openai-billing' ? <><Field label="每 1 显示单位对应的内部单位数" hint="附件站点：500000 单位 = 1 美元。"><input required value={value.unitsPerDollar} onChange={e => patch({ unitsPerDollar: e.target.value })} /></Field>
        <Field label="查询路径覆盖"><input value={value.paths.quota ?? ''} placeholder={value.adapter === 'newapi-cx' ? '/api/token/cx' : '/api/usage/token/'} onChange={e => patch({ paths: e.target.value ? { quota: e.target.value } : {} })} /></Field></>
        : <><Field label="查询窗口（天，UTC 日期）"><input required type="number" min={1} max={3660} value={value.windowDays} onChange={e => patch({ windowDays: Number(e.target.value) })} /></Field>
          <Field label="总额度路径"><input value={value.paths.subscription ?? ''} placeholder="/v1/dashboard/billing/subscription" onChange={e => patch({ paths: { ...value.paths, subscription: e.target.value || undefined } })} /></Field>
          <Field label="用量路径"><input value={value.paths.usage ?? ''} placeholder="/v1/dashboard/billing/usage" onChange={e => patch({ paths: { ...value.paths, usage: e.target.value || undefined } })} /></Field>
          <Check label="已确认查询窗口与总额度口径一致" checked={value.billingWindowConfirmed} onChange={v => patch({ billingWindowConfirmed: v })} hint="不勾选时，余额会标为估算，不进入确认额度合计。" /></>}
      <Field label="请求超时（毫秒）"><input type="number" required min={1000} max={60000} step={1000} value={value.timeoutMs} onChange={e => patch({ timeoutMs: Number(e.target.value) })} /></Field>
      <Field wide label="附加请求头（JSON）" hint="鉴权由查询类型处理。无需填写 Authorization、Cookie 或 Host。"><textarea rows={3} className="mono" value={headers} onChange={e => setHeaders(e.target.value)} /></Field>
    </div></details>
    <Check label="启用这个供应商" checked={value.enabled} onChange={v => patch({ enabled: v })} />
    {initial && <p className="form-note">修改供应商配置后，关联 Key 需重新查询，历史记录仍会保留。</p>}
    <FormError error={submit.error} /><Actions busy={submit.busy} cancel={cancel} />
  </form>;
}
export function KeyForm({ initial, providers, providerId, save, cancel }: { initial?: KeyView; providers: Provider[]; providerId?: string; save: (input: KeyInput) => Promise<void>; cancel: () => void }) {
  const [value, set] = useState<KeyInput>(initial ? { providerId: initial.providerId, name: initial.name, enabled: initial.enabled, tags: initial.tags, threshold: initial.threshold, aggregation: initial.aggregation, balanceGroup: initial.balanceGroup }
    : { providerId: providerId ?? providers[0]?.id ?? '', name: '', secret: '', enabled: true, tags: [], threshold: null, aggregation: 'excluded', balanceGroup: '' });
  const [visible, setVisible] = useState(false), submit = useSubmit();
  const patch = (change: Partial<KeyInput>) => set(old => ({ ...old, ...change }));
  return <form onSubmit={e => { e.preventDefault(); void submit.run(() => save({ ...value, secret: value.secret?.trim() || undefined })); }}><div className="form-grid">
    <Field label="所属供应商"><select required value={value.providerId} onChange={e => patch({ providerId: e.target.value })}>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    <Field label="Key 别名"><input autoFocus required maxLength={100} value={value.name} placeholder="例如：日常主用" onChange={e => patch({ name: e.target.value })} /></Field>
    <Field wide label={initial ? `替换 Key（当前 ${initial.mask}）` : 'API Key'} hint={initial ? '留空则保留。替换后从新的额度基线开始记录。' : '仅保存在后端，列表和 Bot 只显示掩码。'}><span className="secret-input"><input type={visible ? 'text' : 'password'} required={!initial} autoComplete="off" value={value.secret ?? ''} placeholder={initial ? '留空保留当前 Key' : 'sk-...'} onChange={e => patch({ secret: e.target.value })} /><button type="button" className="icon-button" aria-label={visible ? '隐藏 Key' : '显示 Key'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></Field>
    <Field label="标签（逗号分隔）"><input value={value.tags.join(', ')} onChange={e => patch({ tags: e.target.value.split(/[,，]/).map(v => v.trim()) })} onBlur={() => patch({ tags: value.tags.filter(Boolean) })} placeholder="工作, 备用" /></Field>
    <Field label="低额度阈值" hint="留空继承全局阈值。"><input value={value.threshold ?? ''} inputMode="decimal" placeholder="继承全局" onChange={e => patch({ threshold: e.target.value || null })} /></Field>
    <Field label="额度汇总方式"><select value={value.aggregation} onChange={e => patch({ aggregation: e.target.value as KeyInput['aggregation'] })}><option value="excluded">不参与汇总（默认）</option><option value="independent">已确认是独立余额</option><option value="shared">与其他 Key 共用余额</option></select></Field>
    {value.aggregation === 'shared' && <Field label="共享余额组" hint="同一供应商、同一单位下，同组只计一份余额。"><input required value={value.balanceGroup} placeholder="例如：主账户" onChange={e => patch({ balanceGroup: e.target.value })} /></Field>}
  </div><Check label="启用自动查询" checked={value.enabled} onChange={v => patch({ enabled: v })} />
    <FormError error={submit.error} /><Actions busy={submit.busy} cancel={cancel} /></form>;
}
interface Preview { rows: { index: number; name: string; mask: string; duplicate: boolean }[]; added: number }
export function ImportForm({ providers, done, cancel, providerId }: { providers: Provider[]; done: (count: number) => Promise<void>; cancel: () => void; providerId?: string }) {
  const [selected, setSelected] = useState(providerId ?? providers[0]?.id ?? ''), [text, setText] = useState(''), [preview, setPreview] = useState<Preview | null>(null);
  const submit = useSubmit();
  const payload = () => ({ providerId: selected, rows: text.split('\n').map(s => s.trim()).filter(Boolean).map((line, index) => {
    const split = line.indexOf('|'); return split > 0 ? { name: line.slice(0, split).trim(), secret: line.slice(split + 1).trim() } : { name: `Key ${index + 1}`, secret: line };
  }) });
  return <form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
    if (!preview) setPreview(await api<Preview>('/keys/import', 'POST', { ...payload(), preview: true }));
    else { const result = await api<Preview>('/keys/import', 'POST', { ...payload(), preview: false }); await done(result.added); }
  }); }}><Field label="所属供应商"><select value={selected} onChange={e => { setSelected(e.target.value); setPreview(null); }}>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    <Field label="批量粘贴 Key" hint="每行一个；可用“别名 | Key”。最多 500 行，重复项会跳过。"><textarea autoComplete="off" required rows={7} value={text} onChange={e => { setText(e.target.value); setPreview(null); }} placeholder={'日常主用 | sk-...\n备用 | sk-...'} className="mono" /></Field>
    {preview && <div className="import-preview"><p><CheckCircle2 size={16} /> 可导入 {preview.rows.filter(r => !r.duplicate).length} 项，跳过 {preview.rows.filter(r => r.duplicate).length} 个重复项</p>{preview.rows.map(row => <div key={row.index}><span>{row.name}</span><code>{row.mask}</code><Badge tone={row.duplicate ? 'amber' : 'green'}>{row.duplicate ? '重复' : '新 Key'}</Badge></div>)}</div>}
    <FormError error={submit.error} /><Actions busy={submit.busy} cancel={cancel}>{preview ? '确认导入' : '预览并检查重复'}</Actions></form>;
}
function list(text: string): string[] { return text.split(/[\s,，]+/).map(s => s.trim()).filter(Boolean); }
export function ChannelForm({ channel, save, test }: { channel: Channel; save: (input: ChannelInput) => Promise<void>; test: () => Promise<void> }) {
  const [value, set] = useState<ChannelInput>({ ...channel, token: undefined });
  const [users, setUsers] = useState(channel.allowedUsers.join('\n')), [groups, setGroups] = useState(channel.allowedGroups.join('\n'));
  const [targets, setTargets] = useState(channel.targets.map(t => `${t.kind}:${t.id}`).join('\n'));
  const [token, setToken] = useState(''), [clearToken, setClear] = useState(false), submit = useSubmit();
  const patch = (change: Partial<ChannelInput>) => set(old => ({ ...old, ...change }));
  const parseTargets = () => targets.split('\n').filter(s => s.trim()).map(line => {
    const match = line.trim().match(/^(private|group):(-?\d+)$/); if (!match) throw new Error('通知目标格式应为 private:个人ID 或 group:群ID，每行一个');
    return { kind: match[1] as 'private' | 'group', id: match[2] };
  });
  return <form onSubmit={e => { e.preventDefault(); void submit.run(async () => { await save({ ...value, token: clearToken ? '' : token || undefined, allowedUsers: list(users), allowedGroups: list(groups), targets: parseTargets() }); setToken(''); }); }}>
    {channel.platform === 'qq' && <p className="form-note">连接参数可在上方自动配置。日常只需设置使用权限和通知目标。</p>}
    <details className="advanced" open={channel.platform === 'telegram' ? true : undefined}><summary>{channel.platform === 'qq' ? '高级：手动 OneBot 连接' : 'Bot 凭据'}</summary><div className="form-grid">
      <Field wide label={channel.platform === 'qq' ? 'OneBot Access Token' : 'Telegram Bot Token'} hint={channel.hasToken ? '已有 token，留空保留。' : '保存后不会返回完整 token。'}><input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder={channel.hasToken ? '••••••••（已保存）' : '请输入 token'} /></Field>
      {channel.platform === 'qq' && <Field wide label="OneBot WebSocket 地址" hint="项目 Docker 部署使用 ws://snowluma:3001/；本机开发使用 ws://127.0.0.1:3001/。"><input required type="url" value={value.endpoint} onChange={e => patch({ endpoint: e.target.value })} /></Field>}
    </div>{channel.hasToken && <Check label="清除已保存的 token" checked={clearToken} onChange={setClear} />}</details><div className="form-grid">
      <Field label="允许使用的个人 ID" hint="每行一个。群查询也检查发送者 ID。"><textarea required={value.enabled} rows={3} value={users} onChange={e => setUsers(e.target.value)} /></Field>
      <Field label="允许使用的群 ID" hint="Telegram 群 ID 通常为负数；私聊不需要。"><textarea rows={3} value={groups} onChange={e => setGroups(e.target.value)} /></Field>
      <Field wide label="通知目标" hint="每行 private:个人ID 或 group:群ID。Telegram 私聊需先给 Bot 发送消息。"><textarea rows={3} value={targets} onChange={e => setTargets(e.target.value)} placeholder={'private:123456\ngroup:-100123456'} /></Field>
    </div><Check label="启用平台连接" checked={value.enabled} onChange={v => patch({ enabled: v })} />
    <FormError error={submit.error} /><div className="form-actions"><Button type="button" variant="outline" loading={submit.busy} disabled={!channel.enabled || !channel.targets.length} onClick={() => void submit.run(test)}>发送测试消息</Button><Button type="submit" loading={submit.busy}>保存平台设置</Button></div>
  </form>;
}
export function SettingsForm({ settings, save }: { settings: Settings; save: (input: Settings) => Promise<void> }) {
  const [value, set] = useState(settings), submit = useSubmit();
  const patch = (change: Partial<Settings>) => set(old => ({ ...old, ...change }));
  return <form onSubmit={e => { e.preventDefault(); void submit.run(() => save(value)); }}><div className="form-grid">
    <Field label="自动刷新间隔（分钟）"><input type="number" min={1} max={1440} required value={value.refreshMinutes} onChange={e => patch({ refreshMinutes: Number(e.target.value) })} /></Field>
    <Field label="默认低额度阈值" hint="按每个 Key 的显示单位比较，可在 Key 中覆盖。"><input required value={value.defaultThreshold} onChange={e => patch({ defaultThreshold: e.target.value })} /></Field>
    <Field label="连续失败多少次后提醒"><input type="number" min={1} max={20} required value={value.failureThreshold} onChange={e => patch({ failureThreshold: Number(e.target.value) })} /></Field>
    <Field label="同一问题重复提醒间隔（小时）"><input type="number" min={1} max={168} required value={value.reminderHours} onChange={e => patch({ reminderHours: Number(e.target.value) })} /></Field>
    <Field label="采样历史保留（天）"><input type="number" min={1} max={3650} required value={value.snapshotDays} onChange={e => patch({ snapshotDays: Number(e.target.value) })} /></Field>
    <Field label="查询与通知记录保留（天）"><input type="number" min={1} max={365} required value={value.taskDays} onChange={e => patch({ taskDays: Number(e.target.value) })} /></Field>
    <Field label="日报时间"><input type="time" required value={value.dailyTime} onChange={e => patch({ dailyTime: e.target.value })} /></Field>
    <Field label="时区"><input required value={value.timezone} onChange={e => patch({ timezone: e.target.value })} placeholder="Asia/Shanghai" /></Field>
  </div><Check label="启用每日额度摘要" checked={value.dailyEnabled} onChange={v => patch({ dailyEnabled: v })} hint="发送到已启用消息平台配置的通知目标。" />
    <FormError error={submit.error} /><Actions busy={submit.busy} /></form>;
}
export function BackupPanel({ restored }: { restored: () => Promise<void> }) {
  const [password, setPassword] = useState(''), [file, setFile] = useState<File | null>(null), [confirmation, setConfirmation] = useState(''), submit = useSubmit();
  return <div><p className="muted">备份包含凭据和历史，以口令加密。恢复会覆盖现有数据；请先停用 QQ 和 Telegram，恢复后手动重新启用。</p>
    <Field label="备份 / 恢复口令（至少 10 位）"><input type="password" minLength={10} value={password} onChange={e => setPassword(e.target.value)} autoComplete="off" /></Field>
    <Button variant="outline" loading={submit.busy} disabled={password.length < 10} onClick={() => void submit.run(async () => {
      const backup = await api<{ filename: string; content: string }>('/backup', 'POST', { password });
      const url = URL.createObjectURL(new Blob([backup.content], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = backup.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    })}><FileDown size={16} />下载加密备份</Button>
    <details className="advanced"><summary>从备份恢复</summary><Field label="选择 .qrb 备份文件"><input type="file" accept=".qrb,application/json" onChange={e => setFile(e.target.files?.[0] ?? null)} /></Field>
      <Field label="输入“恢复并覆盖”确认" hint="恢复将替换当前所有供应商、Key、历史和设置。"><input value={confirmation} onChange={e => setConfirmation(e.target.value)} /></Field>
      <Button variant="danger" disabled={!file || password.length < 10 || confirmation !== '恢复并覆盖'} loading={submit.busy} onClick={() => void submit.run(async () => {
        if (!file) return; await api('/restore', 'POST', { password, content: await file.text(), confirmation }); await restored(); setConfirmation('');
      })}><Upload size={16} />恢复并覆盖数据</Button></details><FormError error={submit.error} />
  </div>;
}
