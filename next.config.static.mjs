import { createMDX } from 'fumadocs-mdx/next';
import { getStaticDocsConfig } from './scripts/static-docs-config.mjs';

const withMDX = createMDX();

export default withMDX(getStaticDocsConfig());
