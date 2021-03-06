/*
 * 策略：
 * log 数据先缓存到本地，然后再根据一定的规则（比如：应用服务器当前不繁忙 or 本地资源积累到一定大小的时候 or 到达一定上传时间）上传数据
 *
 **/

/**
  * 数据结构
  *  {
      userId: '',
      resource: '',
      operation: '',
      status: 1,
      ip: '',
      createdAt: '',
      originRequest: {
        url: '',
        method: '',
        body: {},
        userAgent: ''
      },
      originResponse: {
        statusCode: 200,
        body: {}
      },
    }
  */

import {promisifyAll} from 'bluebird'
import readline from 'linebyline'
import fs from 'fs'
import {join as pathJoin} from 'path'
import {sync as mkdirpSync} from 'mkdirp'
import debugMod from 'debug'
import MongodbSaver from './mongodbSaver'

const debug = debugMod('rest-log')
promisifyAll(fs)
const logger = console.log.bind(console)

/**
 * 日期格式化
 * @param {Date} date 
 * @returns {String}
 */
const dateFormat = (date) => {
  if (!(date instanceof Date)) {
    return ''
  }

  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate()
  ].join('-')
}


class RestLog {
  /**
   * 构造函数
   * @param   {object}      opts                            配置项
   * @param   {function}    opts.getUserId                  获取用户ID
   * @param   {function}    opts.getResource                获取当前对应的资源
   * @param   {string}      opts.localPath                  本地的缓存目录
   * @param   {function}    opts.filter                     url 过滤 return true 才需要保存
   * @param   {object}      opts.dbSaver                    数据库的配置
   * @param   {object}      opts.dbSaver.dbClient           已连接数据库的客户端实例
   * @param   {string}      opts.dbSaver.collectionName     数据集合名
   * @param   {object}      opts.uploadCondition            缓存数据的上传规则
   * @param   {number}      opts.uploadCondition.filesLimit     最大缓存文件数
   * @param   {number}      opts.uploadCondition.fileSizeLimit  缓存文件最大体积（KB）
   * @param   {number}      opts.uploadCondition.fileExpireTime 缓存文件过期时间（秒）
   * @param   {number}      opts.uploadCondition.intervalTime   缓存目录轮询检测时间（秒）
   * @return {[type]}      [description]
   */
  constructor ({getUserId, getResource, localPath, filter, dbSaver, strict={}, uploadCondition={}}) {
    if (typeof getUserId !== 'function') {
      throw new Error('must give a function to get userId')
    }

    if (typeof getResource !== 'function') {
      throw new Error('must give a function to get Resource')
    }

    this.getUserId = getUserId
    this.getResource = getResource

    this.localPath = localPath || pathJoin(__dirname, '../../data')
    this.filter = filter

    let {dbClient, collectionName} = dbSaver
    if (!dbClient) throw new Error('no dbClient found')
    collectionName = collectionName || 'restlog'
    this.dbSaver = new MongodbSaver({dbClient, collectionName})

    this.bodySizeLimit = 2048

    this.strictObj = strict

    this.filesLimit = uploadCondition.filesLimit || 1
    this.fileSizeLimit = (uploadCondition.fileSizeLimit || 10 ) * 1024
    this.fileExpireTime = (uploadCondition.fileExpireTime || 10 ) * 1000 // default: 3 * 60
    this.intervalTime = (uploadCondition.intervalTime || 10 ) * 1000 // default: 60
    mkdirpSync(this.localPath)

    this.onSubmitting = false
    setInterval(()=> {
      this.submit()
    }, this.intervalTime)
  }

  /**
   * 数据搜集 - koa@2 中间件
   * @param  {[type]}   ctx  [description]
   * @param  {Function} next [description]
   * @return {[type]}        [description]
   */
  async middleware_koa (ctx, next) {
    let optData = {}

    let {url, method, ip} = ctx
    method = method.toLowerCase()

    if (typeof this.filter === 'function' && !this.filter(url, method)) {
      debug(`no need log ${url} ${method}`)
      return next()
    }

    let reqBody = ctx.request.body || {}
    if (JSON.stringify(reqBody).length >= this.bodySizeLimit) {
      reqBody = {}
    }

    let userId = await this.getUserId(ctx) || null // logout && normal
    const resource = await this.getResource(ctx) || null

    Object.assign(optData, {
      resource: resource,
      operation: method,
      ip: ip,     // 注意这里获取到的 IP 被 KOA 转成 IPv6 格式了
      status: 0,
      createdAt: new Date(),
      originRequest: {
        url: url,
        method: method,
        userAgent: ctx.headers['user-agent'] || 'unknown',
        body: reqBody
      }
    })

    let err = null
    try {
      await next()
    } catch (error) {
      logger(`error happened ${err}`)
      err = error
    }


    let resBody = ctx.body || {}
    if (JSON.stringify(resBody).length >= this.bodySizeLimit) {
      resBody = {}
    }

    userId = userId || await this.getUserId(ctx) || null // logout && normal

    Object.assign(optData, {
      userId: userId,
      status: err ? -1 : 1,
      originResponse: {
        statusCode: err ? (err.status || 500) : (ctx.status || 404),
        body: resBody
      }
    })


    for (const key in this.strictObj) {
      const strictItem = this.strictObj[key]
      if (typeof strictItem === 'boolean' && strictItem && !optData.hasOwnProperty(key)) {
        debug(`optData not found ${key}`)
        return
      }
    }

    // 提交数据，交由下游方法来处理
    this.submit(optData)

    if (err) {
      throw err
    }
  }

  /**
   * 获取绑定上下文的 koa 中间件
   * @return {function}     koa 中间件
   */
  getMiddleware() {
    return this.middleware_koa.bind(this)
  }

  /**
   * 检测当前缓存数据的状态
   * @return {boolean}   当前是否需要将缓存数据上传数据库
   */
  async checkStatus() {
    const files = await fs.readdirAsync(this.localPath)

    // 当前未提交文件数操过预计
    if (files.length > this.filesLimit) {
      return true
    }

    for (let fileName of files) {
      const file = pathJoin(this.localPath, fileName)
      const status = await fs.statAsync(file)

      // 当前文件的大小大于一定值
      if (status.size > this.fileSizeLimit) {
        return true
      }

      // 当前文件的过期时间
      const outDate = new Date().getTime() - status.birthtime.getTime()
      if ( outDate >= this.fileExpireTime ) {
        return true
      }
    }

    return false
  }

  /**
   * 提交数据
   * 等规则满足后，提交到远端
   * @param  {object} optData 用户操作数据
   * @return
   */
  submit(optData) {
    debug('submit', optData, this.onSubmitting)

    const self = this
    ;(async function () {
      try {
        // 数据暂存本地
        if (optData) {
          await self.saveLocal.call(self, optData)
        }

        // 检测当前数据库是否处于上传状态
        if (self.onSubmitting) {
          return debug('onSubmitting...')
        }

        // 若条件满足，上传到数据库
        const status = await self.checkStatus.call(self)
        debug('check upload status', status)
        if (status) {
          self.submitting = true
          await self.local2Remote.call(self)
        }
      } catch (err) {
        debug('submit error', err)
      }
      self.onSubmitting = false
    })()
  }

  /**
   * 将数据暂存到本地
   * @param  {[type]} optData 用户操作数据
   * @return
   */
  async saveLocal(optData) {
    const now_data = dateFormat(new Date)
    const file = pathJoin(this.localPath, now_data + '.log')
    await fs.appendFileAsync(file,
      JSON.stringify(optData) + '\n',
      {
        encoding: 'utf8',
        flags: 'a+'
      }
    )
  }

  /**
   * 将数据上传到远端数据库
   * @return
   */
  async local2Remote() {
    debug('local2remote start')
    let files = null
    try {
      files = await fs.readdirAsync(this.localPath)
    } catch (error) {
      debug(`get files from ${this.localPath} fail`, error)
    }

    if (!files) {
      return
    }

    debug(`get files from ${this.localPath}`, files)

    for (let fileName of files) {
      if ( !fileName.match(/^\d{4}-(0?[1-9]|1[0-2])-(0?[1-9]|[1-2]\d|3[0-1]).log$/ig) ) {
        return
      }

      const fileDir = pathJoin(this.localPath, fileName)
      await new Promise((resolve, reject)=> {
        const rl = readline(fileDir)
        rl.on('line', (line, lineCount)=> {
          if (!line) {
            return resolve(null)
          }

          let obj = null
          try {
            obj = JSON.parse(line)
            debug(`get line -${lineCount}- obj`)
          } catch (err) {
            debug(`path line info fail @ ${fileDir}`, err)
            return
          }

          obj.createdAt = new Date(obj.createdAt)
          this.dbSaver.push(obj)
            .then(resolve)
            .catch(reject)
        }).on('error', (err)=> {
          debug(`read file ${fileDir} line by line fail`, err)
          reject(err)
        }).on('end', ()=> {
          resolve(null)
        })
      })
      debug(`update all data from ${fileDir} to remote db`)

      await fs.unlinkAsync(fileDir)
      debug(`delete file ${fileDir}`)
    }

    debug('local2remote over')
  }

  /**
   * 拉取数据
   * @param  {object} filter            筛选条件
   * @param  {date}   filter.startAt    开始时间
   * @param  {date}   filter.endAt      结束时间
   * @param  {string} filter.userId     操作用户ID
   * @param  {string} filter.resource   操作对应的资源
   * @param  {string} filter.operation  操作类型
   * @param  {number} filter.page       列表分页
   * @param  {number} filter.pageSize   列表单页长度
   * @return {array}         操作记录数据
   */
  async search(filter) {
    return await this.dbSaver.pull(filter)
  }

  /**
   * 返回一定过滤条件的数据量
   * @param  {object} filter 查询过滤条件 同 search 方法
   * @return {number}        数据量
   */
  async count(filter) {
    return await this.dbSaver.count(filter)
  }
}

export default RestLog
