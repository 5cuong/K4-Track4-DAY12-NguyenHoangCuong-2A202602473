"""Small statistics helpers."""
import numpy as np


def wilson(k, n, z=1.96):
    """Wilson score interval for a proportion k/n (95 % by default). Returns (low, high)."""
    # TODO (Bước 4): hãy tự cài hàm này. Gợi ý:
    #   Khoảng tin cậy Wilson. p = k/n; d = 1 + z^2/n; tâm = (p + z^2/(2n)) / d; nửa rộng = z *
    #   sqrt(p(1-p)/n + z^2/(4n^2)) / d. Trả (tâm - nửa rộng, tâm + nửa rộng) cắt trong [0, 1]. Nếu n = 0
    #   trả (nan, nan).
    raise NotImplementedError("TODO wilson: xem GUIDE.md, Bước 4")


def rate(flags):
    """{'k','n','rate','ci95'} for a boolean array."""
    flags = np.asarray(flags, bool)
    k, n = int(flags.sum()), int(flags.size)
    lo, hi = wilson(k, n)
    return {"k": k, "n": n, "rate": k / n if n else float("nan"), "ci95": [lo, hi]}


def wasserstein1(a, b, n=200):
    """1-D Wasserstein distance between two samples (mean absolute difference of the quantile functions)."""
    q = np.linspace(0.005, 0.995, n)
    return float(np.mean(np.abs(np.quantile(a, q) - np.quantile(b, q))))
