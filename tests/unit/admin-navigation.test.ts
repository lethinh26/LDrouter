import { describe, expect, it } from 'vitest';
import { adminNavigationItems, getAdminPageTitle } from '@web/lib/admin-navigation';

describe('admin navigation registry', () => {
  it('keeps destinations unique and labels available for each navigation surface', () => {
    const destinations = adminNavigationItems.map((item) => item.to);
    expect(new Set(destinations).size).toBe(destinations.length);
    expect(adminNavigationItems.every((item) => item.label && item.description && item.keywords && item.icon)).toBe(true);
  });

  it('resolves page titles for root, exact routes and nested settings paths', () => {
    expect(getAdminPageTitle('/')).toBe('Dashboard');
    expect(getAdminPageTitle('/requests')).toBe('Requests');
    expect(getAdminPageTitle('/settings/system')).toBe('Settings');
    expect(getAdminPageTitle('/unknown')).toBe('Admin');
  });
});
