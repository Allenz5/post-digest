package main

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"sync"
	"time"
)

// 浏览器调用的节流与退避。
//
// humanize 已经把单次请求"内部"的动作拉开了间距——悬停、点击之间的对数正态延迟。
// 但请求"之间"一直没有间隔，而这才是会被识别的特征：十几个全新浏览器、指纹一致、
// 零间隔连发。pace 给浏览器启动之间的间隔加一个带抖动的下限；penalize 在站点开始
// 返回挑战页时退避。

const (
	paceMin    = 5 * time.Second
	paceJitter = 5 * time.Second

	// 第一档退避要短到能在一次工具调用里睡掉——调用方没有别的等待手段，
	// 而单次调用被 MCP 客户端切断的时限约 60s。
	backoffBase = 30 * time.Second
	backoffMax  = 15 * time.Minute
	// 单次 wait 调用最多睡这么久；更长的冷却分几次调用睡完。
	waitCap = 45 * time.Second
	// 同一轮冷却里被挡回这么多次就放弃——挂在那里等不是办法，调用方该去做别的。
	maxBlocked = 3
)

type throttle struct {
	mu      sync.Mutex
	last    time.Time
	until   time.Time
	strikes int
	blocked int // 本轮冷却里被挡回的次数
}

var browserGate = &throttle{}

// pace 阻塞到距上次浏览器启动足够久。它在 newBrowser 里调用，所以 MCP 工具、
// HTTP handler、登录三条路都自动付这个代价，不用各自记着。
func (t *throttle) pace() {
	t.mu.Lock()
	wait := time.Duration(0)
	if !t.last.IsZero() {
		gap := paceMin + time.Duration(rand.Int63n(int64(paceJitter)))
		if elapsed := time.Since(t.last); elapsed < gap {
			wait = gap - elapsed
		}
	}
	t.last = time.Now().Add(wait)
	t.mu.Unlock()

	if wait > 0 {
		time.Sleep(wait)
	}
}

// check 报告还需冷却多久。它不自己等——等待是 wait 工具的事，调用方要能自己决定
// 是等下去还是先去做别的。
func (t *throttle) check() error {
	t.mu.Lock()
	remaining := time.Until(t.until)
	if remaining <= 0 {
		t.blocked = 0 // 本轮冷却结束
		t.mu.Unlock()
		return nil
	}
	t.blocked++
	blocked, strikes := t.blocked, t.strikes
	t.mu.Unlock()

	if blocked >= maxBlocked {
		return fmt.Errorf(
			"小红书限流未能等过去：已被挡回 %d 次，仍需 %s。不要再等了，"+
				"把这次读取报为失败，让调用方决定还要不要这条",
			blocked, remaining.Round(time.Second))
	}
	return fmt.Errorf(
		"小红书正在限流，需要冷却 %s（已连续 %d 次，第 %d/%d 次被挡回）。这个平台没有失效，"+
			"只是此刻不能用——调用 wait 等它过去，然后重试",
		remaining.Round(time.Second), strikes, blocked, maxBlocked)
}

// cool 睡掉一段冷却，最多 waitCap，返回实际睡了多久和还剩多久。分段是因为单次
// 工具调用不能无限期阻塞；剩余不为零时调用方再调一次即可。
func (t *throttle) cool(ctx context.Context) (slept, remaining time.Duration) {
	t.mu.Lock()
	remaining = time.Until(t.until)
	givenUp := t.blocked >= maxBlocked
	t.mu.Unlock()

	// 已经判定放弃就别再睡了，否则 wait 会变成一个无限期挂起的地方。
	if remaining <= 0 || givenUp {
		return 0, remaining
	}

	slept = min(remaining, waitCap)
	timer := time.NewTimer(slept)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
	return slept, remaining - slept
}

func (t *throttle) penalize() {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.strikes++
	wait := backoffBase << (t.strikes - 1)
	if wait > backoffMax || wait <= 0 {
		wait = backoffMax
	}
	t.until = time.Now().Add(wait)
}

func (t *throttle) succeed() {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.strikes = 0
	t.blocked = 0
	t.until = time.Time{}
}

// throttled 判断一个错误是不是站点在限流。挑战页永远不会让动作等待的选择器就绪，
// 所以表现为超时——但单纯的慢页面也是超时。两者都当限流，代价是多等一轮；
// 都不当限流，代价是账号。
func throttled(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, sign := range []string{"deadline exceeded", "context canceled", "timeout", "429"} {
		if strings.Contains(msg, sign) {
			return true
		}
	}
	return false
}
