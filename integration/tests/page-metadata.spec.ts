import { expect, test } from '@playwright/test'
import { extractMetaContent } from '../meta-tag-utils'

test('a static page serves its own Open Graph tags', async ({ request }) => {
  const response = await request.get('/download')
  const html = await response.text()

  expect(extractMetaContent(html, 'property', 'og:title')).toBe('Download HyperShield')
  expect(extractMetaContent(html, 'property', 'og:url')).toMatch(/\/download$/)
})

test('site links serve the HyperShield social preview card', async ({ request }) => {
  const response = await request.get('/')
  const html = await response.text()
  const imageUrl = extractMetaContent(html, 'property', 'og:image')

  expect(extractMetaContent(html, 'property', 'og:title')).toBe('HyperShield')
  expect(extractMetaContent(html, 'property', 'og:site_name')).toBe('HyperShield')
  expect(imageUrl).toMatch(/\/images\/hypershield-logo-and-text-1200x630\.png$/)
  expect(extractMetaContent(html, 'name', 'twitter:image')).toBe(imageUrl)
  expect(html).not.toContain('@ShieldBatteryBW')
})
