import { BaseTexture } from './BaseTexture';
import { ImageResource } from './resources/ImageResource';
import { CanvasResource } from './resources/CanvasResource';
import { TextureUvs } from './TextureUvs';
import { settings } from '@pixi/settings';
import { Rectangle, Point } from '@pixi/math';
import { uid, TextureCache, getResolutionOfUrl, EventEmitter } from '@pixi/utils';

const DEFAULT_UVS = new TextureUvs();

/**
 * 纹理表示图像或图像的一部分信息。
 *
 * 不能直接将其添加到显示列表中；请将其用作精灵的纹理。
 * 如果没有为纹理提供区域，则使用整个图像。
 *
 * 您可以直接从图像创建纹理，然后多次重复使用，如下所示：
 *
 * ```js
 * let texture = PIXI.Texture.from('assets/image.png');
 * let sprite1 = new PIXI.Sprite(texture);
 * let sprite2 = new PIXI.Sprite(texture);
 * ```
 *
 * 如果您没有将纹理区域传递给构造函数，它将启用`noFrame`模式：
 * 它订阅baseTexture事件，并同时自动调整大小。
 *
 * 由SVG制成的纹理（已加载或未加载）在文件完成处理之前无法使用。
 * 您可以通过查看精灵的_textureID属性来进行检查。
 * ```js
 * var texture = PIXI.Texture.from('assets/image.svg');
 * var sprite1 = new PIXI.Sprite(texture);
 * //如果纹理文件已完成处理，sprite1._textureID将不为undefined
 * ```
 * 您可以使用ticker或rAF来确保您的精灵在加载完成纹理后执行处理。请参阅issue #3068。
 *
 * @class
 * @extends PIXI.utils.EventEmitter
 * @memberof PIXI
 */
export class Texture extends EventEmitter
{
    /**
     * @param {PIXI.BaseTexture} baseTexture - 用于从中创建纹理的基础纹理源
     * @param {PIXI.Rectangle} [frame] - 要显示的纹理的矩形框
     * @param {PIXI.Rectangle} [orig] - 原始纹理区域
     * @param {PIXI.Rectangle} [trim] - 原始纹理的修剪矩形
     * @param {number} [rotate] - 指示纹理打包器如何旋转纹理。请参见{@link PIXI.groupD8}
     * @param {PIXI.Point} [anchor] - 用于精灵放置/旋转的默认锚点
     */
    constructor(baseTexture, frame, orig, trim, rotate, anchor)
    {
        super();

        /**
         * 纹理是否分配了任何区域数据？
         *
         * 如果没有在构造函数中传递任何区域，则自动启用此模式。
         *
         * 在这种模式下，纹理订阅了baseTexture事件，并在发生任意更改时触发 `update` 。
         *
         * 当心，加载或调整baseTexture事件的大小后，可能会触发两次！
         * 如果需要更多控制，请订阅baseTexture本身。
         *
         * ```js
         * texture.on('update', () => {});
         * ```
         *
         * Any assignment of `frame` switches off `noFrame` mode.
         * 任何对`frame`的分配都会关闭`noFrame`模式。
         *
         * @member {boolean}
         */
        this.noFrame = false;

        if (!frame)
        {
            this.noFrame = true;
            frame = new Rectangle(0, 0, 1, 1);
        }

        if (baseTexture instanceof Texture)
        {
            baseTexture = baseTexture.baseTexture;
        }

        /**
         * 该纹理使用的基本纹理。
         *
         * @member {PIXI.BaseTexture}
         */
        this.baseTexture = baseTexture;

        /**
         * BaseTexture图像在渲染时实际复制到Canvas / WebGL的区域，
         * 不管实际的区域大小或位置如何（可能受修剪的纹理图集影响）
         *
         * @member {PIXI.Rectangle}
         */
        this._frame = frame;

        /**
         * 原始纹理的修剪区域，在放入图集之前，请手动更改`trim`的坐标后调用`updateUvs()`。
         *
         * @member {PIXI.Rectangle}
         */
        this.trim = trim;

        /**
         * 让渲染器知道纹理是否有效。如果为false，则无法渲染。
         *
         * @member {boolean}
         */
        this.valid = false;

        /**
         *让渲染器知道纹理是否已更新（主要用于WebGL uv更新）
         *
         * @member {boolean}
         */
        this.requiresUpdate = false;

        /**
         * WebGL UV数据缓存。可用作一个quad(二个triangle)
         *
         * @member {PIXI.TextureUvs}
         * @protected
         */
        this._uvs = DEFAULT_UVS;

        /**
         * 纹理默认的TextureMatrix实例
         * 默认情况下，不会创建该对象，因为它很重
         *
         * @member {PIXI.TextureMatrix}
         */
        this.uvMatrix = null;

        /**
         * 原始纹理的区域，在它被放入图集之前
         *
         * @member {PIXI.Rectangle}
         */
        this.orig = orig || frame;// new Rectangle(0, 0, 1, 1);

        this._rotate = Number(rotate || 0);

        if (rotate === true)
        {
            // this is old texturepacker legacy, some games/libraries are passing "true" for rotated textures
            this._rotate = 2;
        }
        else if (this._rotate % 2 !== 0)
        {
            throw new Error('attempt to use diamond-shaped UVs. If you are sure, set rotation manually');
        }

        /**
         * 使用此纹理创建精灵时，默认的描点。
         * 在创建后更改`defaultAnchor`不会更新精灵的描点。
         * @member {PIXI.Point}
         * @default {0,0}
         */
        this.defaultAnchor = anchor ? new Point(anchor.x, anchor.y) : new Point(0, 0);

        /**
         * 精灵和TextureMatrix实例可以观察到更新ID。
         * 调用updateUvs()将其递增。
         *
         * @member {number}
         * @protected
         */

        this._updateID = 0;

        /**
         * 将纹理添加到纹理缓存的ID数组。
         * 只要使用了Texture.addToCache，就会自动设置该选项，
         * 但如果直接将纹理添加到TextureCache数组，则可能不会设置该选项。
         *
         * @member {string[]}
         */
        this.textureCacheIds = [];

        if (!baseTexture.valid)
        {
            baseTexture.once('loaded', this.onBaseTextureUpdated, this);
        }
        else if (this.noFrame)
        {
            // if there is no frame we should monitor for any base texture changes..
            if (baseTexture.valid)
            {
                this.onBaseTextureUpdated(baseTexture);
            }
        }
        else
        {
            this.frame = frame;
        }

        if (this.noFrame)
        {
            baseTexture.on('update', this.onBaseTextureUpdated, this);
        }
    }

    /**
     * 在gpu上更新此纹理。
     *
     * 调用TextureResource更新。
     *
     * If you adjusted `frame` manually, please call `updateUvs()` instead.
     * 如果手动调整 `frame` ，请改为调用`updateUvs()`。
     *
     */
    update()
    {
        if (this.baseTexture.resource)
        {
            this.baseTexture.resource.update();
        }
    }

    /**
     * 在更新基础纹理时调用
     *
     * @protected
     * @param {PIXI.BaseTexture} baseTexture - 基础纹理
     */
    onBaseTextureUpdated(baseTexture)
    {
        if (this.noFrame)
        {
            if (!this.baseTexture.valid)
            {
                return;
            }

            this._frame.width = baseTexture.width;
            this._frame.height = baseTexture.height;
            this.valid = true;
            this.updateUvs();
        }
        else
        {
            // TODO this code looks confusing.. boo to abusing getters and setters!
            // 如果用户为我们提供尺寸大于调整尺寸纹理的框架，则可能是一个问题
            this.frame = this._frame;
        }

        this.emit('update', this);
    }

    /**
     * 销毁纹理
     *
     * @param {boolean} [destroyBase=false] 是否一起销毁基础纹理
     */
    destroy(destroyBase)
    {
        if (this.baseTexture)
        {
            if (destroyBase)
            {
                const { resource } = this.baseTexture;

                // delete the texture if it exists in the texture cache..
                // this only needs to be removed if the base texture is actually destroyed too..
                if (resource && TextureCache[resource.url])
                {
                    Texture.removeFromCache(resource.url);
                }

                this.baseTexture.destroy();
            }

            this.baseTexture.off('update', this.onBaseTextureUpdated, this);

            this.baseTexture = null;
        }

        this._frame = null;
        this._uvs = null;
        this.trim = null;
        this.orig = null;

        this.valid = false;

        Texture.removeFromCache(this);
        this.textureCacheIds = null;
    }

    /**
     * 克隆一个新的纹理对象。
     *
     * @return {PIXI.Texture} 新的纹理对象
     */
    clone()
    {
        return new Texture(this.baseTexture, this.frame, this.orig, this.trim, this.rotate, this.defaultAnchor);
    }

    /**
     * 更新内部WebGL UV缓存。更改纹理的 `frame` 或 `trim` 后使用。
     * 改变frame调用
     */
    updateUvs()
    {
        if (this._uvs === DEFAULT_UVS)
        {
            this._uvs = new TextureUvs();
        }

        this._uvs.set(this._frame, this.baseTexture, this.rotate);

        this._updateID++;
    }

    /**
     * 可以根据您提供的源创建一个新的精灵的辅助函数。
     * 源可以是-帧id、图像url、视频url、canvas元素、video元素、base texture
     *
     * @static
     * @param {string|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement|PIXI.BaseTexture} source
     *        从中创建纹理的来源
     * @param {object} [options] 请参见 {@link PIXI.BaseTexture} 的构造函数。
     * @param {boolean} [strict] Enforce strict-mode, see {@link PIXI.settings.STRICT_TEXTURE_CACHE}.
     * @return {PIXI.Texture} 新创建的精灵
     */
    static from(source, options = {}, strict = settings.STRICT_TEXTURE_CACHE)
    {
        const isFrame = typeof source === 'string';
        let cacheId = null;

        if (isFrame)
        {
            cacheId = source;
        }
        else
        {
            if (!source._pixiId)
            {
                source._pixiId = `pixiid_${uid()}`;
            }

            cacheId = source._pixiId;
        }

        let texture = TextureCache[cacheId];

        // Strict-mode rejects invalid cacheIds
        if (isFrame && strict && !texture)
        {
            throw new Error(`The cacheId "${cacheId}" does not exist in TextureCache.`);
        }

        if (!texture)
        {
            if (!options.resolution)
            {
                options.resolution = getResolutionOfUrl(source);
            }

            texture = new Texture(new BaseTexture(source, options));
            texture.baseTexture.cacheId = cacheId;

            BaseTexture.addToCache(texture.baseTexture, cacheId);
            Texture.addToCache(texture, cacheId);
        }

        // lets assume its a base texture!
        return texture;
    }

    /**
     * Create a new Texture with a BufferResource from a Float32Array.
     * RGBA values are floats from 0 to 1.
     * @static
     * @param {Float32Array|Uint8Array} buffer The optional array to use, if no data
     *        is provided, a new Float32Array is created.
     * @param {number} width - Width of the resource
     * @param {number} height - Height of the resource
     * @param {object} [options] 请参见 {@link PIXI.BaseTexture} 的构造函数。
     * @return {PIXI.Texture} The resulting new BaseTexture
     */
    static fromBuffer(buffer, width, height, options)
    {
        return new Texture(BaseTexture.fromBuffer(buffer, width, height, options));
    }

    /**
     * Create a texture from a source and add to the cache.
     *
     * @static
     * @param {HTMLImageElement|HTMLCanvasElement} source - The input source.
     * @param {String} imageUrl - File name of texture, for cache and resolving resolution.
     * @param {String} [name] - Human readable name for the texture cache. If no name is
     *        specified, only `imageUrl` will be used as the cache ID.
     * @return {PIXI.Texture} Output texture
     */
    static fromLoader(source, imageUrl, name)
    {
        const resource = new ImageResource(source);

        resource.url = imageUrl;

        const baseTexture = new BaseTexture(resource, {
            scaleMode: settings.SCALE_MODE,
            resolution: getResolutionOfUrl(imageUrl),
        });

        const texture = new Texture(baseTexture);

        // No name, use imageUrl instead
        if (!name)
        {
            name = imageUrl;
        }

        // lets also add the frame to pixi's global cache for 'fromLoader' function
        BaseTexture.addToCache(texture.baseTexture, name);
        Texture.addToCache(texture, name);

        // also add references by url if they are different.
        if (name !== imageUrl)
        {
            BaseTexture.addToCache(texture.baseTexture, imageUrl);
            Texture.addToCache(texture, imageUrl);
        }

        return texture;
    }

    /**
     * 将纹理添加到全局TextureCache。该缓存在整个PIXI对象之间共享。
     *
     * @static
     * @param {PIXI.Texture} texture - 要添加到缓存的纹理。
     * @param {string} id - 将根据其存储纹理的id。
     */
    static addToCache(texture, id)
    {
        if (id)
        {
            if (texture.textureCacheIds.indexOf(id) === -1)
            {
                texture.textureCacheIds.push(id);
            }

            if (TextureCache[id])
            {
                // eslint-disable-next-line no-console
                console.warn(`Texture added to the cache with an id [${id}] that already had an entry`);
            }

            TextureCache[id] = texture;
        }
    }

    /**
     * 从全局纹理缓存中移除纹理。
     *
     * @static
     * @param {string|PIXI.Texture} texture - 要移除的纹理或纹理实例本身的id
     * @return {PIXI.Texture|null} 被移除的纹理
     */
    static removeFromCache(texture)
    {
        if (typeof texture === 'string')
        {
            const textureFromCache = TextureCache[texture];

            if (textureFromCache)
            {
                const index = textureFromCache.textureCacheIds.indexOf(texture);

                if (index > -1)
                {
                    textureFromCache.textureCacheIds.splice(index, 1);
                }

                delete TextureCache[texture];

                return textureFromCache;
            }
        }
        else if (texture && texture.textureCacheIds)
        {
            for (let i = 0; i < texture.textureCacheIds.length; ++i)
            {
                // Check that texture matches the one being passed in before deleting it from the cache.
                if (TextureCache[texture.textureCacheIds[i]] === texture)
                {
                    delete TextureCache[texture.textureCacheIds[i]];
                }
            }

            texture.textureCacheIds.length = 0;

            return texture;
        }

        return null;
    }

    /**
     * 返回baseTexture的分辨率
     *
     * @member {number}
     * @readonly
     */
    get resolution()
    {
        return this.baseTexture.resolution;
    }

    /**
     * 帧指定此纹理使用的基础纹理的区域。
     * 手动更改`frame`的坐标后，请调用`updateUvs()`。
     *
     * @member {PIXI.Rectangle}
     */
    get frame()
    {
        return this._frame;
    }

    set frame(frame) // eslint-disable-line require-jsdoc
    {
        this._frame = frame;

        this.noFrame = false;

        const { x, y, width, height } = frame;
        const xNotFit = x + width > this.baseTexture.width;
        const yNotFit = y + height > this.baseTexture.height;

        if (xNotFit || yNotFit)
        {
            const relationship = xNotFit && yNotFit ? 'and' : 'or';
            const errorX = `X: ${x} + ${width} = ${x + width} > ${this.baseTexture.width}`;
            const errorY = `Y: ${y} + ${height} = ${y + height} > ${this.baseTexture.height}`;

            throw new Error('Texture Error: frame does not fit inside the base Texture dimensions: '
                + `${errorX} ${relationship} ${errorY}`);
        }

        this.valid = width && height && this.baseTexture.valid;

        if (!this.trim && !this.rotate)
        {
            this.orig = frame;
        }

        if (this.valid)
        {
            this.updateUvs();
        }
    }

    /**
     * 指示纹理是否在图集内旋转
     * set to 2 to compensate for texture packer rotation
     * set to 6 to compensate for spine packer rotation
     * 可用于旋转或镜像精灵
     * See {@link PIXI.groupD8} for explanation
     *
     * @member {number}
     */
    get rotate()
    {
        return this._rotate;
    }

    set rotate(rotate) // eslint-disable-line require-jsdoc
    {
        this._rotate = rotate;
        if (this.valid)
        {
            this.updateUvs();
        }
    }

    /**
     * 纹理的宽度（以像素为单位）。
     *
     * @member {number}
     */
    get width()
    {
        return this.orig.width;
    }

    /**
     * 纹理的高度（像素）。
     *
     * @member {number}
     */
    get height()
    {
        return this.orig.height;
    }
}

function createWhiteTexture()
{
    const canvas = document.createElement('canvas');

    canvas.width = 16;
    canvas.height = 16;

    const context = canvas.getContext('2d');

    context.fillStyle = 'white';
    context.fillRect(0, 0, 16, 16);

    return new Texture(new BaseTexture(new CanvasResource(canvas)));
}

function removeAllHandlers(tex)
{
    tex.destroy = function _emptyDestroy() { /* empty */ };
    tex.on = function _emptyOn() { /* empty */ };
    tex.once = function _emptyOnce() { /* empty */ };
    tex.emit = function _emptyEmit() { /* empty */ };
}

/**
 * 空纹理，通常不必创建多个空纹理。
 * 无法销毁。
 *
 * @static
 * @constant
 * @member {PIXI.Texture}
 */
Texture.EMPTY = new Texture(new BaseTexture());
removeAllHandlers(Texture.EMPTY);
removeAllHandlers(Texture.EMPTY.baseTexture);

/**
 * 16x16大小的白色纹理，用于图形和其他用途
 * 无法销毁。
 *
 * @static
 * @constant
 * @member {PIXI.Texture}
 */
Texture.WHITE = createWhiteTexture();
removeAllHandlers(Texture.WHITE);
removeAllHandlers(Texture.WHITE.baseTexture);
