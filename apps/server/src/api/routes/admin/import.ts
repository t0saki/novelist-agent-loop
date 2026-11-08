/** /api/admin/import-v1*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import type { FastifyInstance } from 'fastify';
import type { V1ImportJob, V1ImportPreview } from '@novelist/shared';
import { zV1ImportPreviewRequest, zV1ImportRequest } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { getV1Job, previewV1, startV1Import } from '../../../services/v1-import.js';
import { audit, parseBody } from '../../helpers.js';
import { badRequest } from '../../problem.js';

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post('/api/admin/import-v1/preview', async (req): Promise<V1ImportPreview> => {
    const body = parseBody(zV1ImportPreviewRequest, req.body);
    const url = body.databaseUrl ?? deps.config.v1DatabaseUrl;
    if (!url) throw badRequest('缺少 v1 数据库地址（NOVELIST_V1_DATABASE_URL 或 databaseUrl）');
    return previewV1(url);
  });

  app.post('/api/admin/import-v1', async (req, reply) => {
    const body = parseBody(zV1ImportRequest, req.body);
    const job = await startV1Import(deps, body);
    await audit(deps, req, 'import.v1.start', job.id, { novels: body.novels });
    return reply.code(202).send(job);
  });

  app.get<{ Params: { id: string } }>('/api/admin/import-v1/jobs/:id', async (req): Promise<V1ImportJob> => getV1Job(deps, req.params.id));
}
