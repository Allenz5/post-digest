package main

import "testing"

func TestDescCarriesContent(t *testing.T) {
	cases := []struct {
		name string
		desc string
		want bool
	}{
		{"空正文", "", false},
		{
			// 补跑那天被弃掉的两篇就长这样：论点全在图里，正文只剩索引。
			"只有话题标签",
			"#具身智能[话题]# #机器人[话题]# #AI创业[话题]#",
			false,
		},
		{"裸标签写法", "#具身智能 #机器人 #AI创业 #思考", false},
		{
			"标签加一句话，仍托不住",
			"#AI[话题]# 看完这组图你就懂了",
			false,
		},
		{
			"正文自己讲清楚了",
			"具身智能这一年最大的变化不是模型，是数据采集的成本终于降下来了。" +
				"遥操作一小时的数据以前要两千块，现在几百块就能拿到，而且质量还更稳定。" +
				"这直接改变了创业公司能不能自己攒数据集这件事。#具身智能[话题]#",
			true,
		},
		{
			"空白不算长度",
			"短文本\n\n\n\n        \t\t\t        \n\n\n",
			false,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := descCarriesContent(c.desc); got != c.want {
				t.Errorf("descCarriesContent(%q) = %v, want %v", c.desc, got, c.want)
			}
		})
	}
}
