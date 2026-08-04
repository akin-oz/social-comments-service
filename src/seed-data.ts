import type { Platform } from './shared/types.js';

export interface SeedTenant {
  label: string;
  accountId: string;
  externalTenantId: string;
  socialAccountId: string;
  platform: Platform;
  externalAccountId: string;
  credentialReference: string;
  postId: string;
  externalPostId: string;
  publishedAt: string;
}

/**
 * Fixed identifiers shared by the seed, the PostgreSQL composition, the README,
 * and the isolation tests, so every one of them refers to the same rows.
 *
 * Two tenants exist specifically so a cross-tenant read has something real to
 * fail to find.
 */
export const seedTenants: readonly SeedTenant[] = [
  {
    label: 'tenant A',
    accountId: '2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001',
    externalTenantId: 'tenant-a',
    socialAccountId: '2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b011',
    platform: 'instagram',
    externalAccountId: 'ig-account-a',
    credentialReference: 'secret://social/instagram/tenant-a',
    postId: '2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b002',
    externalPostId: 'ig-post-1',
    publishedAt: '2026-08-01T09:00:00.000Z',
  },
  {
    label: 'tenant B',
    accountId: '7c3d9e10-4a5b-4c6d-8e9f-01a2b3c4d005',
    externalTenantId: 'tenant-b',
    socialAccountId: '7c3d9e10-4a5b-4c6d-8e9f-01a2b3c4d015',
    platform: 'instagram',
    externalAccountId: 'ig-account-b',
    credentialReference: 'secret://social/instagram/tenant-b',
    postId: '7c3d9e10-4a5b-4c6d-8e9f-01a2b3c4d006',
    externalPostId: 'ig-post-2',
    publishedAt: '2026-08-01T09:30:00.000Z',
  },
];
