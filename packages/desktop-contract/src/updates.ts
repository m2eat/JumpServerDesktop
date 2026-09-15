import { z } from 'zod';
import type { AppUpdateState } from './index';

export const appUpdateStateSchema = z.object({
  currentVersion: z.string().min(1).max(100),
  latestVersion: z.string().min(1).max(100).optional(),
  phase: z.enum(['idle', 'checking', 'available', 'not-available', 'downloading', 'downloaded', 'error']),
  mode: z.enum(['automatic', 'manual', 'disabled']),
  reason: z.enum(['development', 'unsigned-macos', 'linux-package', 'unsupported-platform']).optional(),
  progress: z.number().finite().min(0).max(100).optional(),
  error: z.string().min(1).max(2_000).optional(),
  releaseUrl: z.string().url().max(2_081).optional()
}).strict() satisfies z.ZodType<AppUpdateState>;
