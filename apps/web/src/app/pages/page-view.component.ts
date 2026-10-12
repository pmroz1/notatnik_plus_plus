import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { PageEditorComponent } from './page-editor.component';

/**
 * Route component for /p/:id. The keyed @for guarantees a fresh PageEditorComponent (and
 * therefore a fresh Tiptap instance and save wiring) per page, so state can never leak
 * from one page into another.
 */
@Component({
  selector: 'app-page-view',
  imports: [PageEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (key of [id()]; track key) {
      <app-page-editor [pageId]="key" />
    }
  `,
})
export class PageViewComponent {
  readonly id = input.required<string>();
}
