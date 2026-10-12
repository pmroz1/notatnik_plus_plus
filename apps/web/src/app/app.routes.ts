import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in · Notatnik++',
    loadComponent: () => import('./auth/login.component').then((m) => m.LoginComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell.component').then((m) => m.ShellComponent),
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Notatnik++',
        loadComponent: () => import('./pages/home.component').then((m) => m.HomeComponent),
      },
      {
        path: 'p/:id',
        title: 'Notatnik++',
        loadComponent: () => import('./pages/page-view.component').then((m) => m.PageViewComponent),
      },
      {
        path: 'trash',
        title: 'Trash · Notatnik++',
        loadComponent: () => import('./pages/trash.component').then((m) => m.TrashComponent),
      },
      {
        path: 'settings',
        title: 'Settings · Notatnik++',
        loadComponent: () => import('./settings/settings.component').then((m) => m.SettingsComponent),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
