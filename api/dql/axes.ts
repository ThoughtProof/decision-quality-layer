/**
 * GET /dql/axes
 *
 * Returns metadata for all five axes — useful for clients that want to render
 * per-axis UI or explain verdicts to end users.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AXIS_DEFINITIONS, AXES } from '../../src/types.js';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({
    axes: AXES.map((a) => AXIS_DEFINITIONS[a]),
  });
}
