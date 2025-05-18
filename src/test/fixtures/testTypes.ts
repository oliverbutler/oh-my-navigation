// @ts-nocheck
export type User = {
  id: string;
  name: string;
  email: string;
};

type InternalConfig = {
  debug: boolean;
  timeout: number;
};

export interface ApiResponse {
  status: number;
  data: unknown;
  error?: string;
}

interface PrivateInterface {
  _secret: string;
}

// Zod schema
import { z } from "zod";

export const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(2),
  email: z.string().email(),
});
