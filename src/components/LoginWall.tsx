import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { loginWithCredentials, setupInitialAccount } from '../api/client';
import type { BootstrapResponse } from '../types/tracker';

interface LoginWallProps {
  configured: boolean;
  initialNotice?: string | null;
  onAuthenticated: (
    token: string,
    username: string,
    bootstrap?: BootstrapResponse
  ) => void | Promise<void>;
}

export function LoginWall({ configured, initialNotice, onAuthenticated }: LoginWallProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialNotice || null);

  useEffect(() => {
    if (initialNotice) {
      setError(initialNotice);
    }
  }, [initialNotice]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedUser = username.trim();
    if (!trimmedUser) {
      setError('Enter your username.');
      return;
    }
    if (!password) {
      setError('Enter your password.');
      return;
    }

    if (!configured) {
      if (trimmedUser.length < 3) {
        setError('Username must be at least 3 characters.');
        return;
      }
      if (password.length < 8) {
        setError('Password must be at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const result = configured
        ? await loginWithCredentials(trimmedUser, password)
        : await setupInitialAccount(trimmedUser, password);
      await onAuthenticated(result.token, result.username, result.bootstrap);
      setPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="w-11 h-11 rounded-xl bg-slate-900 text-white flex items-center justify-center mx-auto shadow-xs">
            {configured ? <Lock className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            PricePulse
          </h1>
          <p className="text-sm text-slate-500">
            {configured
              ? 'Sign in to access your private watchlist and price drop alerts.'
              : 'Create your private admin account to lock PricePulse.'}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4"
        >
          {error && (
            <p
              role="alert"
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5 leading-snug pp-feedback-enter"
            >
              {error}
            </p>
          )}

          <div className="space-y-1.5">
            <label htmlFor="login-username" className="block text-xs font-medium text-slate-700">
              Username
            </label>
            <input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Enter username"
              required
              className="w-full h-10 px-3 text-sm text-slate-900 placeholder:text-slate-400 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="login-password" className="block text-xs font-medium text-slate-700">
              Password
            </label>
            <div className="relative">
              <input
                id="login-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={configured ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="Enter password"
                required
                className="w-full h-10 pl-3 pr-10 text-sm text-slate-900 placeholder:text-slate-400 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {!configured && (
            <div className="space-y-1.5">
              <label
                htmlFor="login-confirm-password"
                className="block text-xs font-medium text-slate-700"
              >
                Confirm Password
              </label>
              <input
                id="login-confirm-password"
                name="confirmPassword"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="Re-enter password"
                required
                className="w-full h-10 px-3 text-sm text-slate-900 placeholder:text-slate-400 bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full h-10 px-4 bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
          >
            {submitting
              ? configured
                ? 'Signing in...'
                : 'Creating account...'
              : configured
                ? 'Sign In'
                : 'Create Account & Sign In'}
          </button>
        </form>

        <p className="text-center text-xs text-slate-400">
          Protected workspace · Authorized access only
        </p>
      </div>
    </div>
  );
}
