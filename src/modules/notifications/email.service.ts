import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>(
      'SMTP_FROM',
      'SchoolGuard <no-reply@schoolguard.dev>',
    );

    const host = this.config.get<string>('SMTP_HOST');
    if (!host) {
      this.transporter = null;
      return;
    }

    const port = Number(this.config.get<string>('SMTP_PORT', '587'));
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: this.config.get<string>('SMTP_USER')
        ? {
            user: this.config.get<string>('SMTP_USER'),
            pass: this.config.get<string>('SMTP_PASS'),
          }
        : undefined,
    });
  }

  async sendMail(options: SendMailOptions): Promise<void> {
    if (!this.transporter) {
      // Dev/test fallback: log instead of sending so local runs never block.
      this.logger.log(
        `[email disabled] to=${options.to} subject="${options.subject}"`,
      );
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
      });
    } catch (error) {
      // Email delivery is best-effort — never fail the primary operation.
      this.logger.error(
        `Failed to send email to ${options.to}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
