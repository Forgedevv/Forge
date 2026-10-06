import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import HomePage from '../app/page';

it('renders the placeholder', () => {
  render(<HomePage />);
  expect(screen.getByText('FORGE — coming soon')).toBeInTheDocument();
});
