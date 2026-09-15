import { describe, expect, it } from 'vitest';
import { assetsOptionsArgsSchema, parseConnectionToken, parseContext, parseIdentity, parsePermittedAsset, toAsset, toDesktopConnectMethods } from './schemas';

describe('Core authorization response parsing', () => {
  it('allows active connection tokens whose optional approval ticket is null', () => {
    const token = parseConnectionToken({ id: 'connection-token', is_active: true, from_ticket: null });
    expect(token.active).toBe(true);
    expect(token.pending).toBe(false);
    expect(() => parseConnectionToken({ id: 'connection-token', is_active: true, from_ticket: {} })).toThrow();
  });

  it('preserves labeled and plain list category values without treating absent detail protocols as authorization', () => {
    expect(toAsset({
      id: '73611288-6a89-4d95-8e80-6a9705db7002',
      name: '账务 MySQL',
      address: 'mysql.example.test',
      org_id: '0f35c0f1-0ab0-4a15-8f46-1a502ec296f3',
      category: { value: 'database', label: 'Database' },
      type: { value: 'mysql', label: 'MySQL' }
    })).toEqual({
      id: '73611288-6a89-4d95-8e80-6a9705db7002',
      name: '账务 MySQL',
      address: 'mysql.example.test',
      orgId: '0f35c0f1-0ab0-4a15-8f46-1a502ec296f3',
      protocols: [],
      category: 'database',
      type: 'mysql'
    });
    expect(toAsset({
      id: '73611288-6a89-4d95-8e80-6a9705db7002',
      name: '应用主机',
      address: 'app.example.test',
      org_id: '0f35c0f1-0ab0-4a15-8f46-1a502ec296f3',
      category: 'host',
      type: 'linux'
    })).toMatchObject({ category: 'host', type: 'linux', protocols: [] });
  });

  it('keeps inactive, approval, and face-verification tokens blocked', () => {
    expect(parseConnectionToken({ id: 'connection-token', is_active: false, from_ticket: null })).toMatchObject({ active: false, pending: true });
    expect(parseConnectionToken({ id: 'connection-token', is_active: true, from_ticket: 'approval-ticket' }).pending).toBe(true);
    expect(parseConnectionToken({ id: 'connection-token', is_active: true, from_ticket: null, face_token: 'face-verification' }).pending).toBe(true);
  });

  it('accepts only the native KoKo and web Chen context identities', () => {
    const orgId = '00000000-0000-0000-0000-000000000002';
    const siteId = '73611288-6a89-4d95-8e80-6a9705db7002';
    const identity = parseIdentity(siteId, { id: 'user-1', name: '普通用户' }, { id: orgId });
    const asset = parsePermittedAsset({ id: siteId, name: '服务器', address: 'server.example.test', org_id: orgId });
    const options = assetsOptionsArgsSchema.parse({ assetId: asset.id, orgId: identity.orgId });
    const context = {
      siteId,
      userId: identity.userId,
      orgId: options.orgId,
      assetId: asset.id,
      assetName: asset.name,
      address: asset.address,
      accountId: 'account',
      accountName: 'operator'
    };

    expect(parseContext({ ...context, protocol: 'ssh', connectMethod: { value: 'ssh_guide', component: 'koko', type: 'native' } }).orgId).toBe(orgId);
    expect(parseContext({ ...context, protocol: 'telnet', connectMethod: { value: 'ssh_client', component: 'koko', type: 'native' } }).protocol).toBe('telnet');
    expect(parseContext({ ...context, protocol: 'sftp', connectMethod: { value: 'sftp_client', component: 'koko', type: 'native' } }).protocol).toBe('sftp');
    expect(parseContext({ ...context, protocol: 'mysql', connectMethod: { value: 'web_gui', component: 'chen', type: 'web' } }).orgId).toBe(orgId);
    expect(() => parseContext({ ...context, protocol: 'ssh', connectMethod: { value: 'web_cli', component: 'koko', type: 'web' } })).toThrow();
    expect(() => parseContext({ ...context, protocol: 'mysql', connectMethod: { value: 'ssh_client', component: 'koko', type: 'native' } })).toThrow();
    expect(() => parseContext({ ...context, protocol: 'mysql', connectMethod: { value: 'other_gui', component: 'chen', type: 'web' } })).toThrow();
    expect(() => parseContext({ ...context, protocol: 'ssh', connectMethod: 'ssh_guide' })).toThrow();
    expect(() => parseIdentity(siteId, { id: 'user-1', name: '普通用户' }, { id: '../../orgs' })).toThrow();
  });

  it('only exposes Core-enabled native KoKo and web Chen methods for permitted protocols', () => {
    const asset = parsePermittedAsset({
      id: '73611288-6a89-4d95-8e80-6a9705db7002',
      name: '数据库主机',
      address: 'db.example.test',
      org_id: '0f35c0f1-0ab0-4a15-8f46-1a502ec296f3',
      permed_protocols: [{ name: 'ssh' }, { name: 'telnet' }, { name: 'sftp' }, { name: 'mysql' }]
    });
    const methods = toDesktopConnectMethods(asset, {
      ssh: [
        { component: 'koko', type: 'native', value: 'ssh_guide', label: 'SSH Guide', endpoint_protocol: 'ssh' },
        { component: 'koko', type: 'native', value: 'ssh_client', label: 'Disabled SSH client', endpoint_protocol: 'ssh', disabled: true },
        { component: 'koko', type: 'native', value: 'sftp_client', label: 'Wrong SSH endpoint', endpoint_protocol: 'sftp' },
        { component: 'koko', type: 'web', value: 'web_cli', label: 'Web CLI', endpoint_protocol: 'http' }
      ],
      telnet: [{ component: 'koko', type: 'native', value: 'ssh_client', label: 'SSH Client', endpoint_protocol: 'ssh' }],
      sftp: [
        { component: 'koko', type: 'native', value: 'sftp_client', label: 'SFTP Client', endpoint_protocol: 'sftp' },
        { component: 'koko', type: 'web', value: 'web_sftp', label: 'Web SFTP', endpoint_protocol: 'http' },
        { component: 'koko', type: 'native', value: 'ssh_client', label: 'Wrong SFTP endpoint', endpoint_protocol: 'ssh' }
      ],
      mysql: [
        { component: 'chen', type: 'native', value: 'db_client', label: 'Native GUI', endpoint_protocol: 'ssh' },
        { component: 'chen', type: 'web', value: 'web_gui', label: 'Web GUI', endpoint_protocol: 'http' },
        { component: 'lion', type: 'web', value: 'web_gui', label: 'Lion GUI', endpoint_protocol: 'http' }
      ]
    });

    expect(methods).toEqual([
      { value: 'ssh_guide', label: 'SSH Guide', protocol: 'ssh', component: 'koko', type: 'native', endpointProtocol: 'ssh' },
      { value: 'ssh_client', label: 'SSH Client', protocol: 'telnet', component: 'koko', type: 'native', endpointProtocol: 'ssh' },
      { value: 'sftp_client', label: 'SFTP Client', protocol: 'sftp', component: 'koko', type: 'native', endpointProtocol: 'sftp' },
      { value: 'web_gui', label: 'Web GUI', protocol: 'mysql', component: 'chen', type: 'web', endpointProtocol: 'http' }
    ]);
  });

  it('rejects a profile that cannot establish an identity summary', () => {
    expect(() =>
      parseIdentity(
        '73611288-6a89-4d95-8e80-6a9705db7002',
        { id: 'user-1' },
        { id: '0f35c0f1-0ab0-4a15-8f46-1a502ec296f3' }
      )
    ).toThrow();
  });
});
