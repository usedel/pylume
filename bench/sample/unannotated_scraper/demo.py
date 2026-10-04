# -*- coding: utf-8 -*-
# demo.py — s
# Author: yuqi.li
# Date: 2026-08-25

import requests
import jmespath
import pandas
import numpy

mapping = {
    "f12": "code",
    "f14": "name",
    "f2": "price",
    "f3": "zdf",
    "f5": "成交量",
    "f22": "涨速",
    "f237": "转股溢价率",
    "f230": "zdf_stock",
    "f33": "委比",
    # "f20": "scale",
    "f39": "规模",
    "f232": "code_stock",
    "f234": "name_stock",
    "f7": "振幅",
    "f8": "hsl",
    "f10": "lb",
    "f472": "行业",
    "f241": "到期价",
    "f235": "转股价",
    "f236": "转股价值",
    "f238": "纯债溢价",
    "f239": "回售触发价",
    "f240": "强赎触发价",
    "f227": "纯债价值",
    "f350": "涨停价",
    "f351": "跌停价",
    "f242": "转股起始",
    "f26": "start_time",
    "f228": "正股昨收",
    "f229": "正股现价",
    "f11": "5分钟涨跌幅",
    "f24": "60日涨幅",
    "f25": "今年涨幅",
    "f15": "最高",
    "f16": "最低",
    "f17": "今开",
    "f18": "昨收",
    "f352": "均价",
}


def get_quotes():
    params = {
        "ut": "7df74e8df2f3066c56722e9fcb2dd6c9",
        "dpt": "sc.wxdcxcx",
        "invt": "3",
        "fltt": "2",
        "fields": ",".join(mapping.keys()),
        "fs": "b:MK0354",
        "from": "wx_applet",
        "format": "json",
        "wbp2u": "|1|0|1|wx_applet",
        "po": "0",
        "fid": "f39",
        "pn": f"{1}",
        "pz": f"{5}",
    }
    headers = {
        "Connection": "keep-alive",
        "User-Agent": "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.143 Safari/537.36 MicroMessenger/7.0.9.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat",
        "content-type": "application/json",
        "Accept-Encoding": "gzip, deflate",
    }
    url = "https://push2delay2.eastmoney.com/api/qt/clist/get"
    sess = requests.session()
    resp = sess.get(url, params=params, verify=False, proxies=None)
    return resp.json()


# get_quotes()


def main():
    quotes = get_quotes()  # quotes 类型 = get_quotes 的返回观测
    print(quotes)

    result = jmespath.search("data.total", quotes)
    print(result)


if __name__ == "__main__":
    main()
