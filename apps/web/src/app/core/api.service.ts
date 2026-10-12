import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  DocNode,
  ImportSummary,
  PageDetail,
  PageSummary,
  SaveContentResponse,
  SearchResult,
  TagInfo,
} from './api.types';

/** Typed wrappers around the HTTP API. All methods return promises. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  me(): Promise<{ username: string }> {
    return firstValueFrom(this.http.get<{ username: string }>('/api/auth/me'));
  }

  login(username: string, password: string): Promise<{ username: string }> {
    return firstValueFrom(
      this.http.post<{ username: string }>('/api/auth/login', { username, password }),
    );
  }

  logout(): Promise<void> {
    return firstValueFrom(this.http.post<void>('/api/auth/logout', null));
  }

  async listPages(includeDeleted = false): Promise<PageSummary[]> {
    const params = new HttpParams().set('includeDeleted', includeDeleted);
    const res = await firstValueFrom(
      this.http.get<{ pages: PageSummary[] }>('/api/pages', { params }),
    );
    return res.pages;
  }

  getPage(id: string): Promise<PageDetail> {
    return firstValueFrom(this.http.get<PageDetail>(`/api/pages/${encodeURIComponent(id)}`));
  }

  createPage(body: { parentId?: string | null; title?: string }): Promise<PageDetail> {
    return firstValueFrom(this.http.post<PageDetail>('/api/pages', body));
  }

  updateMetadata(
    id: string,
    patch: { title?: string; icon?: string | null; isFavorite?: boolean },
  ): Promise<PageSummary> {
    return firstValueFrom(
      this.http.patch<PageSummary>(`/api/pages/${encodeURIComponent(id)}/metadata`, patch),
    );
  }

  saveContent(id: string, contentJson: DocNode, expectedRevision: number) {
    return firstValueFrom(
      this.http.put<SaveContentResponse>(`/api/pages/${encodeURIComponent(id)}/content`, {
        contentJson,
        expectedRevision,
      }),
    );
  }

  duplicate(id: string): Promise<PageSummary> {
    return firstValueFrom(
      this.http.post<PageSummary>(`/api/pages/${encodeURIComponent(id)}/duplicate`, null),
    );
  }

  move(id: string, parentId: string | null, index: number): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(`/api/pages/${encodeURIComponent(id)}/move`, { parentId, index }),
    );
  }

  softDelete(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/pages/${encodeURIComponent(id)}`));
  }

  restore(id: string): Promise<PageSummary> {
    return firstValueFrom(
      this.http.post<PageSummary>(`/api/pages/${encodeURIComponent(id)}/restore`, null),
    );
  }

  deletePermanently(id: string): Promise<{ deletedPages: number }> {
    return firstValueFrom(
      this.http.delete<{ deletedPages: number }>(
        `/api/pages/${encodeURIComponent(id)}/permanent`,
      ),
    );
  }

  async setTags(id: string, tags: string[]): Promise<string[]> {
    const res = await firstValueFrom(
      this.http.put<{ tags: string[] }>(`/api/pages/${encodeURIComponent(id)}/tags`, { tags }),
    );
    return res.tags;
  }

  async listTags(): Promise<TagInfo[]> {
    const res = await firstValueFrom(this.http.get<{ tags: TagInfo[] }>('/api/tags'));
    return res.tags;
  }

  async search(q: string): Promise<SearchResult[]> {
    const params = new HttpParams().set('q', q);
    const res = await firstValueFrom(
      this.http.get<{ results: SearchResult[] }>('/api/search', { params }),
    );
    return res.results;
  }

  exportWorkspace(): Promise<unknown> {
    return firstValueFrom(this.http.get<unknown>('/api/export'));
  }

  importWorkspace(data: unknown, mode: 'merge' | 'replace'): Promise<ImportSummary> {
    let params = new HttpParams().set('mode', mode);
    if (mode === 'replace') {
      params = params.set('confirm', 'replace-all-pages');
    }
    return firstValueFrom(this.http.post<ImportSummary>('/api/import', data, { params }));
  }

  createBackup(): Promise<{ file: string; sizeBytes: number }> {
    return firstValueFrom(
      this.http.post<{ file: string; sizeBytes: number }>('/api/backup', null),
    );
  }
}
