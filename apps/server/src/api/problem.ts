/** RFC 9457 problem+json（§9.7）。Owner: lane G。 */
import type { ApiProblem } from '@novelist/shared';

export class HttpProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Partial<ApiProblem> = {},
  ) {
    super(message);
  }
  toJSON(): ApiProblem {
    return { type: `https://novelist/errors/${this.code}`, title: this.message, status: this.status, code: this.code, ...this.extra };
  }
}

export const notFound = (what: string) => new HttpProblem(404, 'not_found', `${what}不存在`);
export const badRequest = (message: string, code = 'bad_request') => new HttpProblem(400, code, message);
export const conflict = (message: string, code = 'conflict') => new HttpProblem(409, code, message);
export const forbidden = (message: string, code = 'forbidden') => new HttpProblem(403, code, message);
