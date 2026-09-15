import type { AdapterHost, SshService } from '../host';
import { SshServiceImpl } from './service';

export function createSshService(host: AdapterHost): SshService {
  return new SshServiceImpl(host);
}
