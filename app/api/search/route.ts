import { source } from '@/lib/source';
import { createSearchAPI } from 'fumadocs-core/search/server';

// 静态搜索：构建时把整份搜索索引导出为 JSON（staticGET + revalidate = false），
// 客户端下载一次后在浏览器本地查询，运行时不需要任何搜索函数。
//
// 使用 simple 索引而不是默认的 advanced：
// - advanced 会为每个段落生成独立文档并携带 token 评分映射，
//   导出体积约 91 MB，超出 EdgeOne 单文件 25 MB 限制且客户端无法下载；
// - simple 每页一个文档，索引体积缩小两个数量级，代价是结果
//   只定位到页面级（不带小节锚点和内容摘要）。
const MAX_PAGE_CONTENT_CHARS = 4000;

async function buildSearchIndexes() {
  const indexes = [];

  for (const page of source.getPages()) {
    const structuredData = page.data.structuredData;
    if (!structuredData) continue;

    const { headings, contents } = await structuredData();
    const content = [
      ...headings.map((heading) => heading.content),
      ...contents.map((entry) => entry.content),
    ]
      .join('\n')
      .slice(0, MAX_PAGE_CONTENT_CHARS);

    indexes.push({
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      content,
    });
  }

  return indexes;
}

export const revalidate = false;

export const { staticGET: GET } = createSearchAPI('simple', {
  indexes: buildSearchIndexes,
});
