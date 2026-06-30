import { ZodError } from 'zod';

export type Issue = {
  path: string;
  message: string;
  code?: string;
};

export function extractIssues(err: unknown): Issue[] {
  if (err instanceof ZodError) {
    return err.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
      code: issue.code,
    }));
  }
  if (err instanceof Error) {
    return [{ path: '', message: err.message }];
  }
  return [{ path: '', message: String(err) }];
}
