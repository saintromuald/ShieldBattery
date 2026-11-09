import { Locator, Page } from '@playwright/test'

export abstract class SocialSidebar {
  protected readonly page: Page

  private readonly textHyperShieldChannel: Locator

  protected constructor(page: Page) {
    this.page = page

    this.textHyperShieldChannel = page.locator(
      '[data-testid=social-sidebar] a[href="/chat/1/HyperShield"]',
    )
  }

  async getNameOfHyperShieldChannel(): Promise<string> {
    return await this.textHyperShieldChannel.locator('[data-testid=entry-text]').innerText()
  }

  channelLinkLocator(channelName: string): Locator {
    return this.page.locator(`[data-testid=social-sidebar] a[href^="/chat/"]`, {
      hasText: `#${channelName}`,
    })
  }
}
