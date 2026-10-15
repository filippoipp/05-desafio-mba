import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CompleteUploadDto, InitiateUploadDto } from './dto/video.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start a multipart video upload' })
  async initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = await this.videosService.initiate(user.sub, dto);
    res.setHeader('Location', `/videos/${body.id}`);
    return body;
  }

  @Post(':id/complete')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Complete a multipart upload and enqueue processing',
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const outcome = await this.videosService.complete(user.sub, id, dto.parts);
    res.status(outcome.accepted ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return outcome.video;
  }

  @Public()
  @Get(':publicId/playback')
  @ApiOperation({ summary: 'Presigned URL for ranged playback' })
  playback(@Param('publicId') publicId: string) {
    return this.videosService.playback(publicId);
  }

  @Public()
  @Get(':publicId/download')
  @ApiOperation({ summary: 'Presigned URL for video download' })
  download(@Param('publicId') publicId: string) {
    return this.videosService.download(publicId);
  }

  @Get(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Read a video owned by the caller' })
  getOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.videosService.getForOwner(user.sub, id);
  }
}
