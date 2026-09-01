import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Button } from '../../src/web/ui/button.js';
import { Badge } from '../../src/web/ui/badge.js';
import { Calendar } from '../../src/web/ui/calendar.js';

describe('ui kit', () => {
  it('renders Button/Badge server-side', () => {
    const html = renderToString(<Button variant="outline">Create poll</Button>);
    expect(html).toContain('Create poll');
    expect(renderToString(<Badge>3 replies</Badge>)).toContain('3 replies');
  });
  it('calendar day buttons expose data-date and nav exposes cal-next', () => {
    const html = renderToString(
      <Calendar mode="multiple" selected={[]} defaultMonth={new Date(2026, 8, 1)} />,
    );
    expect(html).toContain('data-date="2026-09-15"');
    expect(html).toContain('cal-next');
  });
});
